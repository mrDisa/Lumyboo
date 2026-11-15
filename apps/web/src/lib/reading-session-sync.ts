import type { components } from './api.generated';
import type { AccountSession } from './auth';
import { requestJSON } from './api';
import { ReadingTimeBusyError } from './reading-time-auto';
import type { LocalDatabase, PendingOperation } from './db';

export type ReadingSessionReport = components['schemas']['ReadingSessionReport'];
type Receipt = components['schemas']['AccountReadingSession'];
export const maxSessionMilliseconds = 86_400_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Legacy records have no edition/device provenance. Never guess these from
// today's catalog or current device metadata, even when the book ID matches.
export function readingSessionReport(op: PendingOperation): ReadingSessionReport | undefined {
 if (op.change.type !== 'session.put' || !uuid.test(op.id) || op.formatVersion !== 1) return;
 const p = op.change.value;
 const milliseconds = Math.round(p.seconds * 1000);
 const day = new Date(`${p.day}T00:00:00Z`);
 if (op.change.key !== p.id || op.entity !== `session:${p.id}` || !uuid.test(p.id) || !p.version || !p.bookId || !p.deviceId || !uuid.test(p.deviceId) || p.deviceId !== op.deviceId || !/^\d{4}-\d{2}-\d{2}$/.test(p.day) || p.day.startsWith('0000') || !Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== p.day || !Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > maxSessionMilliseconds) return;
 return { sessionId: p.id, deviceId: p.deviceId, bookId: p.bookId, version: p.version, day: p.day, milliseconds };
}
function assertOwner(store: LocalDatabase, accountId: string) {
 if (store.scope !== `account:${accountId}`) throw new Error('Аккаунт изменился. Открой профиль заново.');
}
export function validReceipt(receipt: Receipt, accountId: string, report: ReadingSessionReport) {
 const p = receipt?.session;
 return receipt?.accountId === accountId && p && p.sessionId === report.sessionId && p.deviceId === report.deviceId && p.bookId === report.bookId && p.version === report.version && p.day === report.day && Number.isSafeInteger(p.milliseconds) && p.milliseconds >= report.milliseconds && p.milliseconds <= maxSessionMilliseconds && Number.isSafeInteger(p.revision) && p.revision >= 1 && p.revision <= maxSessionMilliseconds;
}
// One bounded batch. Failures stop the batch and leave the immutable
// sending snapshot for retry. No automatic owner changes or guest import.
export async function sendReadingSessions(store: LocalDatabase, session: AccountSession, signal?: AbortSignal) {
 assertOwner(store, session.user.id);
 if (!navigator.locks) throw new Error('Для безопасного сохранения времени открой приложение в обновлённом браузере по HTTPS или на localhost.');
 return navigator.locks.request(`lumyboo-reading-sessions:${store.scope}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
  if (!lock) throw new ReadingTimeBusyError('Время сохраняется в другой вкладке. Дождись завершения и повтори действие.');
  const operations = (await store.outbox.orderBy('sequence').toArray()).filter(op => op.scope === store.scope && readingSessionReport(op));
  // Resolve uncertain requests before taking their newer pending snapshots.
  operations.sort((a, b) => Number(b.state === 'sending') - Number(a.state === 'sending') || a.sequence - b.sequence);
  let sent = 0;
  for (const candidate of operations.slice(0, 50)) {
   signal?.throwIfAborted();
   const op = await store.transaction('rw', store.outbox, async () => {
    const current = await store.outbox.get(candidate.id);
    if (!current) return; // A newer local snapshot compacted this pending one.
    if (current.scope !== store.scope || JSON.stringify(current.change) !== JSON.stringify(candidate.change) || !readingSessionReport(current)) throw new Error('Запись времени изменилась. Открой профиль заново.');
    await store.outbox.update(current.id, { state: 'sending' });
    return { ...current, state: 'sending' as const };
   });
   if (!op) continue;
   const report = readingSessionReport(op)!;
   const receipt = await requestJSON<Receipt>('/reading-sessions/apply', {
    signal, method: 'POST', headers: { 'X-CSRF-Token': session.csrfToken },
    body: JSON.stringify({ accountId: session.user.id, operationId: op.id, session: report }),
   });
   if (!validReceipt(receipt, session.user.id, report)) throw new Error('Сервер не подтвердил запись времени. Сохранение можно повторить.');
   await store.transaction('rw', store.outbox, async () => {
    const current = await store.outbox.get(op.id);
    if (JSON.stringify(current) !== JSON.stringify(op)) throw new Error('Запись времени изменилась. Сохранение можно повторить.');
    // A receipt acknowledges only this exact operation, never a later pending
    // snapshot. Do not overwrite local seconds with a potentially old receipt.
    await store.outbox.delete(op.id);
   });
   sent++;
  }
  return sent;
 });
}
