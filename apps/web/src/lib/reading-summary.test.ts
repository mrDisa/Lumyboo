import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { LocalDatabase, type ReadingSession } from './db';
import { loadReadingSummary } from './reading-summary';
const guest = new LocalDatabase('reading-summary-guest');
const account = new LocalDatabase('reading-summary-account', 'account:test');
const row = (id: string, seconds: number, day = '2026-11-15'): ReadingSession => ({ id, seconds, day, bookId: 'book', version: '1' });
afterEach(async () => { await guest.delete(); await account.delete(); await guest.open(); await account.open(); });
it('keeps visit time separate from the daily total across books and historical targets', async () => {
 await guest.dailyGoals.put({ id: 'local', timeZone: 'UTC', changes: [{ from: '2026-11-14', minutes: 5 }, { from: '2026-11-16', minutes: 20 }] });
 const visit = [row('a', 20.001), row('b', 39.999)];
 await guest.sessions.bulkPut([...visit, { ...row('older', 240), bookId: 'other' }]);
 const result = await loadReadingSummary(guest, visit, new Date('2026-11-15T12:00:00Z'));
 expect(result.milliseconds).toBe(60000);
 expect(result.progress).toMatchObject({ seconds: 300, minutes: 5, complete: true });
 expect(result.days).toEqual([{ day: '2026-11-15', milliseconds: 60000 }]);
});
it('preserves split dates at midnight and uses the owner timezone for today', async () => {
 await account.dailyGoals.put({ id: 'local', timeZone: 'Europe/Moscow', changes: [{ from: '2026-11-14', minutes: 5 }, { from: '2026-11-15', minutes: 10 }] });
 const visit = [row('before', 300, '2026-11-14'), row('after', 1)];
 await account.sessions.bulkPut(visit);
 const result = await loadReadingSummary(account, visit, new Date('2026-11-14T21:00:02Z'));
 expect(result.day).toBe('2026-11-15'); expect(result.milliseconds).toBe(301000);
 expect(result.days).toEqual([{ day: '2026-11-14', milliseconds: 300000 }, { day: '2026-11-15', milliseconds: 1000 }]);
 expect(result.progress).toMatchObject({ seconds: 1, minutes: 10, complete: false, streak: 1 });
});
it('keeps account progress isolated from guest minutes and handles an immediate exit', async () => {
 await guest.sessions.put(row('guest', 3600));
 const result = await loadReadingSummary(account, [], new Date('2026-11-15T12:00:00Z'));
 expect(result.milliseconds).toBe(0); expect(result.days).toEqual([]);
 expect(result.progress).toMatchObject({ seconds: 0, complete: false });
 expect(await guest.sessions.count()).toBe(1);
});
