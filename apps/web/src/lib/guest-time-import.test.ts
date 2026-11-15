import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LocalDatabase, saveReadingSession } from './db';
import { cancelGuestTimeImport, importGuestTime, previewGuestTime } from './guest-time-import';
import { getSession } from './auth';
import { syncAccountGoal, type GoalSnapshot } from './account-daily-goal';
vi.mock('./auth', () => ({ getSession: vi.fn() }));
vi.mock('./account-daily-goal', () => ({ syncAccountGoal: vi.fn() }));
const accountId = '00000000-0000-4000-8000-000000000001';
const store = new LocalDatabase('guest-time-account-tests', `account:${accountId}`);
const guest = new LocalDatabase('guest-time-guest-tests');
const session = { user: { id: accountId, email: 'a@example.test' }, csrfToken: 'csrf' };
const goal: GoalSnapshot['goal'] = { timeZone: 'UTC', revision: 2, changes: [{ from: '2026-11-01', minutes: 20 }] };
const snapshot: GoalSnapshot = { accountId, goal, progress: { day: '2026-11-15', minutes: 20, milliseconds: 0, streak: 0, complete: false } };
const row = { id: '00000000-0000-4000-8000-000000000002', bookId: 'room-for-stories', version: '1', day: '2026-11-14', seconds: 300 };
const reports = new Map<string, number>();
let lose = false;
beforeEach(async () => {
 const { locks } = await vi.importActual<{ locks: LockManager }>('node:worker_threads');
 vi.stubGlobal('navigator', { locks });
 vi.mocked(getSession).mockResolvedValue(session);
 vi.mocked(syncAccountGoal).mockResolvedValue(snapshot);
 reports.clear(); lose = false;
 vi.stubGlobal('fetch', vi.fn(async (url, init) => {
  if (String(url).endsWith('/daily-goal')) return Response.json(snapshot);
  const body = JSON.parse(String(init?.body));
  const key = `${body.accountId}:${body.session.sessionId}`;
  const ms = Math.max(reports.get(key) ?? 0, body.session.milliseconds);
  reports.set(key, ms);
  if (lose) { lose = false; throw new TypeError('lost response'); }
  return Response.json({ accountId: body.accountId, session: { ...body.session, milliseconds: ms, revision: 1 } });
 }));
 await guest.dailyGoals.put({ id: 'local', timeZone: 'Europe/Moscow', changes: [{ from: '2026-11-01', minutes: 5 }] });
 await saveReadingSession(row, guest);
});
afterEach(async () => { vi.unstubAllGlobals(); await store.delete(); await guest.delete(); await store.open(); await guest.open(); });
it('previews historical targets and zones; skips legacy sessions without guessing provenance', async () => {
 await guest.sessions.put({ ...row, id: 'legacy', version: undefined });
 const preview = await previewGuestTime(store, guest);
 expect(preview.guestZone).toBe('Europe/Moscow');
 expect(preview.days).toEqual([{ day: row.day, milliseconds: 300000, guestMinutes: 5, accountMinutes: 20 }]);
 expect(preview.localOnly).toBe(1);
 expect(reports.size).toBe(0);
});
it('imports only selected days, preserves guest/account local data and does not duplicate new choices', async () => {
 await saveReadingSession({ ...row, id: crypto.randomUUID(), day: '2026-11-13' }, guest);
 const original = await guest.sessions.toArray(); const outbox = await guest.outbox.toArray();
 const choice = { preview: await previewGuestTime(store, guest), days: [row.day] };
 expect(await importGuestTime(store, choice)).toBe(0);
 expect(await importGuestTime(store, choice)).toBe(0);
 expect([...reports.values()]).toEqual([300000]);
 expect(await guest.sessions.toArray()).toEqual(original); expect(await guest.outbox.toArray()).toEqual(outbox);
 expect(await store.sessions.count()).toBe(0); expect(await store.outbox.count()).toBe(0);
 expect(await store.dailyGoals.count()).toBe(0);
 await saveReadingSession({ ...row, seconds: 400 }, guest);
 await importGuestTime(store, { preview: await previewGuestTime(store, guest), days: [row.day] });
 expect([...reports.values()]).toEqual([400000]);
});
it('retries frozen payload after response loss and reopen even after later guest reading', async () => {
 const choice = { preview: await previewGuestTime(store, guest), days: [row.day] };
 lose = true;
 await expect(importGuestTime(store, choice)).rejects.toThrow();
 const first = String(vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/apply'))![1]?.body);
 store.close(); await store.open();
 await saveReadingSession({ ...row, seconds: 500 }, guest);
 await expect(importGuestTime(store, choice)).rejects.toThrow('прежний перенос');
 await importGuestTime(store);
 const sent = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/apply'));
 expect(String(sent[1][1]?.body)).toBe(first);
 expect([...reports.values()]).toEqual([300000]); expect(await store.guestTimeImports.count()).toBe(0);
});
it('stops a changed account or target before storing a new choice', async () => {
 const choice = { preview: await previewGuestTime(store, guest), days: [row.day] };
 vi.mocked(getSession).mockResolvedValue({ ...session, user: { ...session.user, id: crypto.randomUUID() } });
 await expect(importGuestTime(store, choice)).rejects.toThrow('Аккаунт изменился');
 vi.mocked(getSession).mockResolvedValue(session);
 vi.mocked(fetch).mockResolvedValue(Response.json({ ...snapshot, goal: { ...goal, revision: 3 } }));
 await expect(importGuestTime(store, choice)).rejects.toThrow('Цель аккаунта изменилась');
 expect(reports.size).toBe(0); expect(await store.guestTimeImports.count()).toBe(0);
});
it('retains a mismatching receipt for retry; cancellation leaves already accepted time', async () => {
 const choice = { preview: await previewGuestTime(store, guest), days: [row.day] };
 const transport = vi.mocked(fetch).getMockImplementation()!;
 vi.mocked(fetch).mockImplementation(async (url, init) => {
  const response = await transport(url, init);
  if (!String(url).endsWith('/apply')) return response;
  return Response.json({ ...await response.json(), accountId: 'other' });
 });
 await expect(importGuestTime(store, choice)).rejects.toThrow('не подтвердил');
 expect(await store.guestTimeImports.count()).toBe(1);
 await cancelGuestTimeImport(store);
 expect(await store.guestTimeImports.count()).toBe(0); expect([...reports.values()]).toEqual([300000]);
});
it('saves at most 50 per click and resumes the remaining frozen selection', async () => {
 for (let i = 0; i < 50; i++) await saveReadingSession({ ...row, id: crypto.randomUUID() }, guest);
 const choice = { preview: await previewGuestTime(store, guest), days: [row.day] };
 expect(await importGuestTime(store, choice)).toBe(1);
 expect((await store.guestTimeImports.get('local'))?.entries).toHaveLength(1);
 expect(await importGuestTime(store)).toBe(0); expect(reports.size).toBe(51);
});
