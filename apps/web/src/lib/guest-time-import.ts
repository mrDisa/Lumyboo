import { randomId } from './random-id';
import { db, type LocalDatabase, type ReadingSession } from './db';
import { getSession } from './auth';
import { authGeneration } from './local-account';
import { requestJSON } from './api';
import { readingSessionReport, validReceipt, type ReadingSessionReport } from './reading-session-sync';
import { ensureDailyGoal, goalMinutes } from './daily-goal';
import { syncAccountGoal, type GoalSnapshot } from './account-daily-goal';
import type { components } from './api.generated';

export interface TimeImportBatch {
 id: 'local'; accountId: string;
 entries: { operationId: string; session: ReadingSessionReport }[];
}
export function guestTimeReport(row: ReadingSession) {
 return readingSessionReport({ id: row.id, formatVersion: 1, scope: 'guest', deviceId: row.deviceId ?? '', sequence: 0, entity: `session:${row.id}`, state: 'pending', change: { type: 'session.put', key: row.id, value: row } });
}
export async function previewGuestTime(store: LocalDatabase, guest = db) {
 const account = await syncAccountGoal(store);
 const goal = await ensureDailyGoal(guest);
 const rows = await guest.sessions.toArray();
 const reports = rows.flatMap(row => { const report = guestTimeReport(row); return report ? [report] : []; });
 const days = [...new Set(reports.map(row => row.day))].sort().reverse().map(day => ({
  day, milliseconds: reports.filter(row => row.day === day).reduce((sum, row) => sum + row.milliseconds, 0),
  guestMinutes: goalMinutes(goal, day), accountMinutes: goalMinutes(account.goal, day),
 }));
 return { account, guestZone: goal.timeZone, reports, days, localOnly: rows.length - reports.length };
}
export type TimeImportPreview = Awaited<ReturnType<typeof previewGuestTime>>;

// Keep original session IDs: the server's cumulative max prevents double counting
// across retries, new choices and continued guest reading. Never copy into the
// account's local recorder or change the guest's sessions/outbox.
export async function importGuestTime(store: LocalDatabase, choice?: { preview: TimeImportPreview; days: string[] }) {
 if (store.scope === 'guest' || !navigator.locks) throw new Error('Для переноса нужен вход, обновлённый браузер и HTTPS или localhost.');
 return navigator.locks.request(`lumyboo-guest-time:${store.scope}`, async () => {
  const generation = authGeneration();
  const session = await getSession();
  const assertOwner = () => {
   if (!session || store.scope !== `account:${session.user.id}` || generation !== authGeneration()) throw new Error('Аккаунт изменился. Открой профиль заново.');
  };
  assertOwner();
  let pending = await store.guestTimeImports.get('local');
  if (pending && choice) throw new Error('Сначала заверши или отмени прежний перенос.');
  if (!pending) {
   if (!choice || choice.preview.account.accountId !== session!.user.id) throw new Error('Открой перенос заново.');
   const current = await requestJSON<GoalSnapshot>('/daily-goal');
   assertOwner();
   if (current.accountId !== session!.user.id || JSON.stringify(current.goal) !== JSON.stringify(choice.preview.account.goal)) throw new Error('Цель аккаунта изменилась. Открой перенос заново.');
   const reports = choice.preview.reports.filter(row => choice.days.includes(row.day));
   if (!reports.length) throw new Error('Выбери дни для переноса.');
   pending = { id: 'local', accountId: session!.user.id, entries: reports.map(report => ({ operationId: randomId(), session: report })) };
   await store.guestTimeImports.put(pending);
  }
  if (pending.accountId !== session!.user.id) throw new Error('Аккаунт изменился.');
  for (const entry of pending.entries.slice(0, 50)) {
   assertOwner();
   const receipt = await requestJSON<components['schemas']['AccountReadingSession']>('/reading-sessions/apply', {
    method: 'POST', headers: { 'X-CSRF-Token': session!.csrfToken }, body: JSON.stringify({ accountId: session!.user.id, ...entry }),
   });
   assertOwner();
   if (!validReceipt(receipt, session!.user.id, entry.session)) throw new Error('Сервер не подтвердил время. Повтори перенос.');
   await store.guestTimeImports.update('local', { entries: (await store.guestTimeImports.get('local'))!.entries.filter(row => row.operationId !== entry.operationId) });
  }
  const remaining = (await store.guestTimeImports.get('local'))!.entries.length;
  if (!remaining) await store.guestTimeImports.delete('local');
  return remaining;
 });
}
export async function cancelGuestTimeImport(store: LocalDatabase) {
 if (!navigator.locks) throw new Error('Браузер не поддерживает безопасный перенос.');
 await navigator.locks.request(`lumyboo-guest-time:${store.scope}`, () => store.guestTimeImports.delete('local'));
}
