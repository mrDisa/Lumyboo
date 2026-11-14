import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import Dexie from 'dexie';
import { LocalDatabase, saveReadingSession } from './db';
import { chooseDailyGoal, ensureDailyGoal, goalDay, goalMinutes, loadDailyProgress, nextGoalDay } from './daily-goal';

const stores: LocalDatabase[] = [];
function database(scope: 'guest' | `account:${string}` = 'guest') {
 const store = new LocalDatabase(`goal-${crypto.randomUUID()}`, scope);
 stores.push(store);
 return store;
}
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.delete())); });
const date = new Date('2026-11-14T12:00:00Z');
it('keeps the captured time zone and target after reopen and travel', async () => {
 const store = database();
 const goal = await ensureDailyGoal(store, date, 'Europe/Moscow');
 expect(goalMinutes(goal, '2026-11-14')).toBe(20);
 store.close(); await store.open();
 expect(await ensureDailyGoal(store, date, 'America/New_York')).toEqual(goal);
 expect(goalDay(goal.timeZone, new Date('2026-11-14T21:01:00Z'))).toBe('2026-11-15');
});
it('replaces only tomorrow’s target, including cancellation and later changes', async () => {
 const store = database();
 await ensureDailyGoal(store, date, 'UTC');
 await chooseDailyGoal(store, 5, date);
 await chooseDailyGoal(store, 30, date);
 let goal = (await store.dailyGoals.get('local'))!;
 expect(goalMinutes(goal, '2026-11-14')).toBe(20);
 expect(goalMinutes(goal, '2026-11-15')).toBe(30);
 expect(goal.changes.filter(change => change.from === '2026-11-15')).toHaveLength(1);
 await chooseDailyGoal(store, 20, date);
 expect(goalMinutes((await store.dailyGoals.get('local'))!, '2026-11-15')).toBe(20);
 await chooseDailyGoal(store, 60, new Date('2026-11-16T10:00:00Z'));
 goal = (await store.dailyGoals.get('local'))!;
 expect(goalMinutes(goal, '2026-11-15')).toBe(20);
 expect(goalMinutes(goal, '2026-11-16')).toBe(20);
 expect(goalMinutes(goal, '2026-11-17')).toBe(60);
 await expect(chooseDailyGoal(store, 7, date)).rejects.toThrow();
});
it('crosses DST, month and year boundaries by calendar date', () => {
 expect(nextGoalDay('2026-12-31')).toBe('2027-01-01');
 expect(nextGoalDay('2028-02-28')).toBe('2028-02-29');
 expect(nextGoalDay('2026-03-08')).toBe('2026-03-09');
 expect(goalDay('America/New_York', new Date('2026-03-09T03:59:59Z'))).toBe('2026-03-08');
 expect(goalDay('America/New_York', new Date('2026-03-09T04:00:00Z'))).toBe('2026-03-09');
});
it('counts multiple books without rounding up and retries never double credit; late sessions keep their day', async () => {
 const store = database();
 const goal = await ensureDailyGoal(store, date, 'UTC');
 const session = { id: 'one', bookId: 'a', day: '2026-11-14', seconds: 600 };
 await saveReadingSession(session, store);
 await saveReadingSession(session, store);
 await saveReadingSession({ ...session, id: 'two', bookId: 'b', seconds: 599.999 }, store);
 expect(await loadDailyProgress(store, goal, '2026-11-14')).toMatchObject({ complete: false, remaining: 1 });
 await saveReadingSession({ ...session, id: 'two', bookId: 'b', seconds: 600 }, store);
 expect(await loadDailyProgress(store, goal, '2026-11-14')).toMatchObject({ complete: true, seconds: 1200 });
 await chooseDailyGoal(store, 5, date);
 const updated = (await store.dailyGoals.get('local'))!;
 expect(await loadDailyProgress(store, updated, '2026-11-15')).toMatchObject({ complete: false, seconds: 0, minutes: 5 });
 await saveReadingSession({ ...session, id: 'late', seconds: 60 }, store);
 expect(await loadDailyProgress(store, updated, '2026-11-14')).toMatchObject({ seconds: 1260, minutes: 20 });
 expect(await loadDailyProgress(store, updated, '2026-11-15')).toMatchObject({ seconds: 0 });
});
it('isolates guest and account targets and time, including concurrent initialization', async () => {
 const guest = database(); const account = database('account:a'); const other = database('account:b');
 await Promise.all([ensureDailyGoal(account, date, 'UTC'), ensureDailyGoal(account, date, 'Europe/Moscow')]);
 await chooseDailyGoal(account, 5, date);
 const guestGoal = await ensureDailyGoal(guest, date, 'UTC');
 const otherGoal = await ensureDailyGoal(other, date, 'UTC');
 expect(goalMinutes((await account.dailyGoals.get('local'))!, '2026-11-15')).toBe(5);
 expect(goalMinutes(guestGoal, '2026-11-15')).toBe(20);
 expect(goalMinutes(otherGoal, '2026-11-15')).toBe(20);
 await saveReadingSession({ id: 'private', bookId: 'a', day: '2026-11-14', seconds: 1200 }, account);
 expect((await loadDailyProgress(guest, guestGoal, '2026-11-14')).seconds).toBe(0);
 expect((await loadDailyProgress(other, otherGoal, '2026-11-14')).seconds).toBe(0);
});
it('adds goals to a v6 database without rewriting historical reading or settings', async () => {
 const store = database(); const old = new Dexie(store.name);
 old.version(6).stores({ settings: 'id', sessions: 'id, day, bookId' });
 await old.table('settings').put({ id: 'local', name: 'Reader' });
 await old.table('sessions').put({ id: 'old', day: '2026-11-13', bookId: 'a', seconds: 65 });
 old.close();
 await store.open();
 await ensureDailyGoal(store, date, 'UTC');
 expect(await store.settings.get('local')).toMatchObject({ name: 'Reader' });
 expect(await store.sessions.get('old')).toMatchObject({ day: '2026-11-13', seconds: 65 });
});

it('continues yesterday’s streak, uses historical goals and repairs a gap after a late report', async () => {
 const store = database();
 const goal = { id: 'local' as const, timeZone: 'UTC', changes: [{ from: '2026-12-28', minutes: 20 }, { from: '2026-12-31', minutes: 5 }] };
 async function read(day: string, seconds: number) {
  await saveReadingSession({ id: day, bookId: 'a', day, seconds }, store);
 }
 await read('2026-12-29', 1200);
 await read('2026-12-30', 1200);
 await read('2026-12-31', 300);
 expect((await loadDailyProgress(store, goal, '2027-01-01')).streak).toBe(3);
 await read('2027-01-01', 299.999);
 expect((await loadDailyProgress(store, goal, '2027-01-01')).streak).toBe(3);
 await read('2027-01-01', 300);
 await read('2027-01-01', 300); // Same snapshot is never counted twice.
 expect((await loadDailyProgress(store, goal, '2027-01-01')).streak).toBe(4);
 expect((await loadDailyProgress(store, goal, '2026-12-30')).streak).toBe(2); // Future reports excluded.
 expect((await loadDailyProgress(store, goal, '2027-01-03')).streak).toBe(0);
 await read('2027-01-03', 300);
 expect((await loadDailyProgress(store, goal, '2027-01-03')).streak).toBe(1);
 await read('2027-01-02', 300);
 expect((await loadDailyProgress(store, goal, '2027-01-03')).streak).toBe(6);
 const other = database('account:other');
 expect((await loadDailyProgress(other, goal, '2027-01-03')).streak).toBe(0);
});
