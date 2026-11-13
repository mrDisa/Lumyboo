import type { components } from './api.generated';
import { getSession, type AccountSession } from './auth';
import { requestJSON } from './api';
import type { LocalDatabase, PendingOperation } from './db';
import { coverageKey, queueStoredReadingCoverage } from './reading-coverage';

export type CoverageReport = components['schemas']['ReadingCoverage'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const keyValid = (s: unknown): s is string => typeof s === 'string' && !!s && [...s].length <= 200 && !s.includes('\0');
export function validCoverageRanges(ranges: unknown, max: number): ranges is [number, number][] {
 if (!Array.isArray(ranges) || !ranges.length || ranges.length > max) return false;
 let end = -1;
 for (const range of ranges) {
  if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isSafeInteger) || range[0] < 0 || range[1] > 1_000_000 || range[0] >= range[1] || range[0] <= end) return false;
  end = range[1];
 }
 return true;
}
export function readingCoverageReport(op: PendingOperation): CoverageReport | undefined {
 if (op.change.type !== 'coverage.put' || op.formatVersion !== 1 || !uuid.test(op.id) || !['pending', 'sending'].includes(op.state)) return;
 const p = op.change.value;
 if (!p || !keyValid(p.bookId) || !keyValid(p.version) || !keyValid(p.paragraph) || !validCoverageRanges(p.ranges, 64)) return;
 let key: unknown;
 try { key = JSON.parse(op.change.key); } catch { return; }
 if (!Array.isArray(key) || key.length !== 4 || !Number.isSafeInteger(key[3]) || key[3] < 0 || op.change.key !== coverageKey(p.bookId, p.version, p.paragraph, key[3]) || op.entity !== `coverage:${op.change.key}`) return;
 return { bookId: p.bookId, version: p.version, paragraph: p.paragraph, ranges: p.ranges.map(range => [...range]) };
}
function validReceipt(receipt: { accountId: string; coverage: CoverageReport }, owner: string, sent: CoverageReport) {
 const p = receipt?.coverage;
 return receipt?.accountId === owner && p && p.bookId === sent.bookId && p.version === sent.version && p.paragraph === sent.paragraph && validCoverageRanges(p.ranges, 256) && sent.ranges.every(([from, to]) => p.ranges.some(([start, end]) => start <= from && end >= to));
}
// One explicit batch, serialized across tabs until local acknowledgement.
// Never replace local coverage with a potentially older operation receipt.
export async function sendReadingCoverage(store: LocalDatabase, session: AccountSession, signal?: AbortSignal) {
 if (store.scope !== `account:${session.user.id}`) throw new Error('Аккаунт изменился. Открой профиль заново.');
 if (!navigator.locks) throw new Error('Для безопасного сохранения открой приложение в обновлённом браузере по HTTPS или на localhost.');
 return navigator.locks.request(`lumyboo-reading-coverage:${store.scope}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
  if (!lock) throw new Error('Фрагменты сохраняются в другой вкладке. Дождись завершения и повтори действие.');
  signal?.throwIfAborted();
  const live = await getSession(signal);
  if (!live || live.user.id !== session.user.id) throw new Error('Аккаунт изменился. Открой профиль заново.');
  signal?.throwIfAborted();
  await queueStoredReadingCoverage(store);
  const operations = (await store.outbox.orderBy('sequence').toArray()).filter(op => op.scope === store.scope && readingCoverageReport(op));
  operations.sort((a, b) => Number(b.state === 'sending') - Number(a.state === 'sending') || a.sequence - b.sequence);
  let sent = 0;
  for (const candidate of operations.slice(0, 50)) {
   signal?.throwIfAborted();
   const op = await store.transaction('rw', store.outbox, async () => {
    const current = await store.outbox.get(candidate.id);
    if (!current) return;
    if (JSON.stringify(current) !== JSON.stringify(candidate)) throw new Error('Фрагменты изменились. Повтори сохранение.');
    await store.outbox.update(current.id, { state: 'sending' });
    return { ...current, state: 'sending' as const };
   });
   if (!op) continue;
   const report = readingCoverageReport(op)!;
   const receipt = await requestJSON<{ accountId: string; coverage: CoverageReport }>('/reading-coverage/apply', {
    signal, method: 'POST', headers: { 'X-CSRF-Token': live.csrfToken },
    body: JSON.stringify({ accountId: live.user.id, operationId: op.id, coverage: report }),
   });
   if (!validReceipt(receipt, live.user.id, report)) throw new Error('Сервер не подтвердил фрагменты текста. Сохранение можно повторить.');
   signal?.throwIfAborted();
   await store.transaction('rw', store.outbox, async () => {
    if (JSON.stringify(await store.outbox.get(op.id)) !== JSON.stringify(op)) throw new Error('Фрагменты изменились. Сохранение можно повторить.');
    await store.outbox.delete(op.id);
   });
   sent++;
  }
  return sent;
 });
}
