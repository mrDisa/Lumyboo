import { randomId } from './random-id';
import type { LocalDatabase } from './db';
import { ApiError, requestJSON } from './api';
import { getSession, type AccountSession } from './auth';
import { authGeneration } from './local-account';
import { ensureDailyGoal, goalDay, goalMinutes, nextGoalDay, type DailyGoal } from './daily-goal';
import type { components } from './api.generated';
export type GoalSnapshot = components['schemas']['AccountDailyGoal'];
type Mutation = components['schemas']['DailyGoalChange'];
function assertOwner(store: LocalDatabase, session: AccountSession | null, generation: string | null) {
 if (!session || store.scope !== `account:${session.user.id}` || generation !== authGeneration()) throw new Error('Аккаунт изменился. Проверь вход заново.');
}
async function saveGoal(store: LocalDatabase, goal: GoalSnapshot['goal']) {
 await store.transaction('rw', store.dailyGoals, async () => {
  const current = await store.dailyGoals.get('local');
  if ((current?.revision ?? 0) > goal.revision) return;
  await store.dailyGoals.put({ id: 'local', ...goal });
 });
}
async function sendPending(store: LocalDatabase, session: AccountSession, generation: string | null) {
 const goal = await store.dailyGoals.get('local');
 if (!goal?.pending) return;
 let response: { accountId: string; goal: GoalSnapshot['goal'] };
 try { response = await requestJSON('/daily-goal', { method: 'POST', headers: { 'X-CSRF-Token': session.csrfToken }, body: JSON.stringify(goal.pending) }); }
 catch (error) {
  if (error instanceof ApiError && (error.status === 409 || error.status === 400)) {
   assertOwner(store, session, generation);
   await store.dailyGoals.update('local', { pending: undefined });
  }
  throw error;
 }
 assertOwner(store, session, generation);
 if (response.accountId !== session.user.id) throw new Error('Аккаунт изменился.');
 await saveGoal(store, response.goal);
}
// An account-specific lock keeps a retry immutable across tabs and clicks.
export async function syncAccountGoal(store: LocalDatabase, minutes?: number, imported?: { guest: DailyGoal; expectedRevision: number; includeHistory?: boolean }): Promise<GoalSnapshot> {
 if (minutes !== undefined && ![5, 10, 20, 30, 60].includes(minutes)) throw new Error('Выбери цель из списка.');
 if (store.scope === 'guest') throw new Error('Открой аккаунт.');
 if (!navigator.locks) throw new Error('Для сохранения цели нужен обновлённый браузер и HTTPS или localhost.');
 return navigator.locks.request(`lumyboo-goal:${store.scope}`, async () => {
  const generation = authGeneration();
  const session = await getSession();
  assertOwner(store, session, generation);
  const verified = session!;
  const local = await ensureDailyGoal(store);
  // Resolve an uncertain prior choice before accepting a new one.
  await sendPending(store, verified, generation);
  let remote: GoalSnapshot | undefined;
  try { remote = await requestJSON<GoalSnapshot>('/daily-goal'); }
  catch (error) { if (!(error instanceof ApiError && error.code === 'daily_goal_not_found')) throw error; }
  assertOwner(store, verified, generation);
  if (remote && remote.accountId !== verified.user.id) throw new Error('Аккаунт изменился.');
  if (imported && (remote?.goal.revision ?? 0) !== imported.expectedRevision) throw new Error('Цель аккаунта изменилась. Открой перенос заново.');
  if (remote) await saveGoal(store, remote.goal);
  if (remote && minutes === undefined && !imported) return remote;
  if (!remote || minutes !== undefined || imported) {
   const goal = remote?.goal ?? imported?.guest ?? local;
   const from = nextGoalDay(goalDay(goal.timeZone));
   const history = imported?.includeHistory === false ? [] : imported ? guestGoalHistory(imported.guest, remote?.goal) : undefined;
   const pending: Mutation = { accountId: verified.user.id, operationId: randomId(), expectedRevision: remote?.goal.revision ?? 0, timeZone: goal.timeZone, from, minutes: (imported ? goalMinutes(imported.guest, nextGoalDay(goalDay(imported.guest.timeZone))) : minutes ?? goalMinutes(local, from)) as Mutation['minutes'], ...(imported ? { initialChanges: history as Mutation['initialChanges'] } : !remote ? { initialChanges: local.changes as Mutation['initialChanges'] } : {}) };
   await store.dailyGoals.update('local', { pending });
   await sendPending(store, verified, generation);
  }
  const result = await requestJSON<GoalSnapshot>('/daily-goal');
  assertOwner(store, verified, generation);
  if (result.accountId !== verified.user.id) throw new Error('Аккаунт изменился.');
  await saveGoal(store, result.goal);
  return result;
 });
}
export type PendingGoalChange = Mutation;

// Reader timing uses the saved account zone during an outage; it never drops
// locally recorded time because the settings endpoint cannot be reached.
export async function prepareDailyGoal(store: LocalDatabase) {
 const local = await ensureDailyGoal(store);
 if (store.scope !== 'guest' && navigator.onLine !== false) {
  try { await syncAccountGoal(store); } catch { /* The card offers a separate account refresh and error. */ }
 }
 return await store.dailyGoals.get('local') ?? local;
}

// Account history always wins from its first saved target onward. Different
// zones retain separate histories because their calendar days are not equivalent.
export function guestGoalHistory(guest: DailyGoal, account?: GoalSnapshot['goal']) {
 if (!account) return guest.changes;
 if (guest.timeZone !== account.timeZone) return [];
 const first = account.changes[0]?.from;
 return first ? guest.changes.filter(change => change.from < first) : [];
}
