import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LocalDatabase, saveReadingSession } from './db';
import { chooseDailyGoal, ensureDailyGoal } from './daily-goal';
import { prepareDailyGoal, syncAccountGoal } from './account-daily-goal';
import { getSession } from './auth';
vi.mock('./auth', () => ({ getSession: vi.fn() }));
const id = '00000000-0000-4000-8000-000000000001';
const session = { user: { id, email: 'goal@example.test' }, csrfToken: 'csrf' };
let store: LocalDatabase;
let remote: { timeZone: string; revision: number; changes: { from: string; minutes: number }[] } | undefined;
let sent: Record<string, unknown>[];
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }); }
beforeEach(async () => {
 store = new LocalDatabase(`account-goal-${crypto.randomUUID()}`, `account:${id}`);
 const { locks } = await vi.importActual<{ locks: LockManager }>('node:worker_threads');
 const prefix = crypto.randomUUID();
 vi.stubGlobal('navigator', { locks: { request: (name: string, callback: LockGrantedCallback<unknown>) => locks.request(prefix + name, callback) } });
 vi.mocked(getSession).mockResolvedValue(session);
 remote = undefined; sent = [];
 vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
  if (init?.method === 'POST') {
   const body = JSON.parse(String(init.body)); sent.push(body);
   remote = { timeZone: body.timeZone, revision: (remote?.revision ?? 0) + 1, changes: body.initialChanges ?? remote?.changes ?? [] };
   remote.changes = [...remote.changes.filter(c => c.from !== body.from), { from: body.from, minutes: body.minutes }];
   return response({ accountId: id, goal: remote });
  }
  return remote ? response({ accountId: id, goal: remote, progress: { day: '2026-11-14', minutes: 20, milliseconds: 1200000, complete: true } }) : response({ error: { code: 'daily_goal_not_found' } }, 404);
 }));
});
afterEach(async () => { await store.delete(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
it('copies initial account goal history, preserving local unsent reading', async () => {
 await ensureDailyGoal(store, new Date('2026-11-13T12:00:00Z'), 'Europe/Moscow');
 await chooseDailyGoal(store, 5, new Date('2026-11-13T12:00:00Z'));
 await saveReadingSession({ id: 'local', bookId: 'book', day: '2026-11-14', seconds: 60 }, store);
 const before = await store.outbox.toArray();
 const result = await syncAccountGoal(store);
 expect(sent[0]).toMatchObject({ accountId: id, expectedRevision: 0, timeZone: 'Europe/Moscow', minutes: 5, initialChanges: [{ from: '2026-11-13', minutes: 20 }, { from: '2026-11-14', minutes: 5 }] });
 expect(result.progress.milliseconds).toBe(1200000);
 expect(await store.outbox.toArray()).toEqual(before);
 expect((await store.sessions.get('local'))?.seconds).toBe(60);
 expect((await store.dailyGoals.get('local'))?.revision).toBe(1);
});
it('uses account time zone and revisions from the other device, without copying guest defaults', async () => {
 remote = { timeZone: 'America/New_York', revision: 4, changes: [{ from: '2026-01-01', minutes: 10 }] };
 await syncAccountGoal(store);
 expect((await store.dailyGoals.get('local'))?.timeZone).toBe('America/New_York');
 await syncAccountGoal(store, 30);
 expect(sent[0]).toMatchObject({ expectedRevision: 4, timeZone: 'America/New_York', minutes: 30 });
 expect(sent[0]).not.toHaveProperty('initialChanges');
});
it('persists an immutable choice across a lost response, reopen and later reading', async () => {
 remote = { timeZone: 'UTC', revision: 1, changes: [{ from: '2026-01-01', minutes: 20 }] };
 const original = fetch;
 vi.stubGlobal('fetch', vi.fn(async (url, init) => { if (init?.method === 'POST') throw new TypeError('lost'); return original(url, init); }));
 await expect(syncAccountGoal(store, 5)).rejects.toThrow();
 const pending = (await store.dailyGoals.get('local'))!.pending;
 expect(pending).toMatchObject({ minutes: 5, expectedRevision: 1 });
 store.close(); await store.open();
 await saveReadingSession({ id: 'new', bookId: 'book', day: '2026-11-14', seconds: 5 }, store);
 vi.stubGlobal('fetch', original);
 await syncAccountGoal(store);
 expect(sent[0]).toEqual(pending);
 expect((await store.dailyGoals.get('local'))!.pending).toBeUndefined();
 expect(await store.sessions.count()).toBe(1); expect(await store.outbox.count()).toBe(1);
});
it('rejects another account before reading or sending data', async () => {
 vi.mocked(getSession).mockResolvedValue({ ...session, user: { ...session.user, id: crypto.randomUUID() } });
 await expect(syncAccountGoal(store, 5)).rejects.toThrow('Аккаунт изменился');
 expect(fetch).not.toHaveBeenCalled(); expect(await store.dailyGoals.count()).toBe(0);
});
it('clears a rejected stale choice so refresh can load the current goal', async () => {
 remote = { timeZone: 'UTC', revision: 3, changes: [{ from: '2026-01-01', minutes: 20 }] };
 const original = fetch;
 vi.stubGlobal('fetch', vi.fn(async (url, init) => init?.method === 'POST' ? response({ error: { code: 'daily_goal_conflict', message: 'Цель изменилась' } }, 409) : original(url, init)));
 await expect(syncAccountGoal(store, 5)).rejects.toThrow('Цель изменилась');
 expect((await store.dailyGoals.get('local'))!.pending).toBeUndefined();
 vi.stubGlobal('fetch', original);
 await syncAccountGoal(store);
 expect((await store.dailyGoals.get('local'))!.revision).toBe(3);
});

it('keeps the existing account zone and time available during an API outage', async () => {
 const local = await ensureDailyGoal(store, new Date('2026-11-14T12:00:00Z'), 'Europe/Moscow');
 vi.mocked(getSession).mockRejectedValue(new TypeError('offline'));
 expect(await prepareDailyGoal(store)).toEqual(local);
 expect(fetch).not.toHaveBeenCalled();
});
