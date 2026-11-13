import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LocalDatabase, saveReadingSession, savePosition, toggleBookmark } from './db';
import { readingSessionReport, sendReadingSessions } from './reading-session-sync';
const accountId = '00000000-0000-4000-8000-000000000001';
const store = new LocalDatabase('reading-session-sync-tests', `account:${accountId}`);
const session = { user: { id: accountId, email: 'a@example.test' }, csrfToken: 'csrf' };
const row = { id: '00000000-0000-4000-8000-000000000002', bookId: 'book', version: '1', day: '2026-11-13', seconds: 1.234 };
const body = (init?: RequestInit) => JSON.parse(String(init?.body));
const receipt = (init?: RequestInit) => { const request = body(init); return new Response(JSON.stringify({ accountId: request.accountId, session: { ...request.session, revision: 1 } })); };
beforeEach(async () => {
 const { locks } = await vi.importActual<{ locks: LockManager }>('node:worker_threads');
 const prefix = crypto.randomUUID();
 vi.stubGlobal('navigator', { locks: { request: (name: string, options: LockOptions, callback: LockGrantedCallback<unknown>) => locks.request(prefix + name, options, callback) } });
 vi.stubGlobal('fetch', vi.fn(async (_url, init) => receipt(init)));
});
afterEach(async () => { vi.unstubAllGlobals(); await store.delete(); await store.open(); });
it('captures device/edition atomically at creation and preserves it after reopen', async () => {
 await saveReadingSession(row, store);
 store.close(); await store.open();
 const saved = await store.sessions.get(row.id); const op = (await store.outbox.toArray())[0];
 expect(saved).toEqual({ ...row, deviceId: op.deviceId });
 expect(saved?.deviceId).toBe((await store.metadata.get('device'))?.deviceId);
 await saveReadingSession({ ...row, seconds: 3 }, store);
 expect((await store.sessions.get(row.id))?.deviceId).toBe(saved?.deviceId);
 expect(readingSessionReport((await store.outbox.toArray())[0])).toEqual({ sessionId: row.id, deviceId: saved?.deviceId, bookId: 'book', version: '1', day: row.day, milliseconds: 3000 });
 for (const change of [{ bookId: 'other' }, { version: '2' }, { day: '2026-11-14' }, { deviceId: crypto.randomUUID() }]) {
  await expect(saveReadingSession({ ...row, ...change, seconds: 4 }, store)).rejects.toThrow('изменились');
 }
});
it('keeps old v5 sessions local without inferring edition or device on upgrade', async () => {
 const name = 'reading-session-old-v5'; const old = new Dexie(name);
 old.version(5).stores({ settings: 'id', positions: 'bookId', bookmarks: 'id, bookId', shelf: 'bookId', downloads: 'bookId', sessions: 'id, day, bookId', positionHistory: 'id, bookId, [bookId+version]', outbox: 'id, sequence, [entity+state]', metadata: 'id', positionChoices: 'bookId', bookmarkChoices: 'id' });
 const upgraded = new LocalDatabase(name, store.scope);
 try {
  const { version: _version, ...legacy } = row;
  await old.table('sessions').put(legacy); old.close(); await upgraded.open();
  expect(await upgraded.sessions.get(row.id)).toEqual(legacy);
  await saveReadingSession({ ...legacy, seconds: 2 }, upgraded);
  await expect(saveReadingSession({ ...row, seconds: 3 }, upgraded)).rejects.toThrow('изменились');
  expect(await sendReadingSessions(upgraded, session)).toBe(0);
  expect(await upgraded.outbox.count()).toBe(1); expect(fetch).not.toHaveBeenCalled();
 } finally { old.close(); await upgraded.delete(); }
});
it('sends only the captured account report and acknowledges without changing local seconds', async () => {
 await saveReadingSession(row, store);
 const p = { bookId: 'book', version: '1', chapter: 0, paragraph: 'p1', offset: .3, updatedAt: 'now' };
 await savePosition(p, store); await toggleBookmark(p, 'Keep', store);
 const all = await store.outbox.toArray(); const op = all.find(op => op.change.type === 'session.put')!;
 expect(await sendReadingSessions(store, session)).toBe(1);
 const [url, init] = vi.mocked(fetch).mock.calls[0];
 expect(url).toBe('/api/v1/reading-sessions/apply');
 expect(body(init)).toEqual({ accountId, operationId: op.id, session: readingSessionReport(op) });
 expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('csrf');
 expect(await store.outbox.toArray()).toEqual(all.filter(entry => entry.id !== op.id));
 expect((await store.sessions.get(row.id))?.seconds).toBe(1.234);
});
it('keeps the exact request for retry after lost response and reopen, preserving later reading', async () => {
 await saveReadingSession(row, store);
 const calls: string[] = [];
 vi.stubGlobal('fetch', vi.fn(async (_url, init) => { calls.push(String(init?.body)); throw new TypeError('Network lost'); }));
 await expect(sendReadingSessions(store, session)).rejects.toThrow('Network lost');
 const sending = (await store.outbox.toArray())[0]; expect(sending.state).toBe('sending');
 await saveReadingSession({ ...row, seconds: 5 }, store);
 store.close(); await store.open();
 vi.stubGlobal('fetch', vi.fn(async (_url, init) => { calls.push(String(init?.body)); return receipt(init); }));
 expect(await sendReadingSessions(store, session)).toBe(2);
 expect(calls[1]).toBe(calls[0]); expect(JSON.parse(calls[2]).session.milliseconds).toBe(5000);
 expect(await store.outbox.count()).toBe(0); expect((await store.sessions.get(row.id))?.seconds).toBe(5);
});
it('never acknowledges reading created while a report is in flight or widens the batch', async () => {
 await saveReadingSession(row, store);
 let finish!: (response: Response) => void;
 vi.stubGlobal('fetch', vi.fn((_url, _init) => new Promise<Response>(resolve => { finish = resolve; })));
 const sending = sendReadingSessions(store, session);
 await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
 const init = vi.mocked(fetch).mock.calls[0][1];
 await saveReadingSession({ ...row, seconds: 8 }, store);
 await saveReadingSession({ ...row, id: crypto.randomUUID(), seconds: 2 }, store);
 finish(receipt(init)); expect(await sending).toBe(1);
 expect(await store.outbox.count()).toBe(2); expect((await store.sessions.get(row.id))?.seconds).toBe(8);
});
it('accepts a greater cumulative receipt but does not apply it to local time', async () => {
 await saveReadingSession(row, store);
 vi.stubGlobal('fetch', vi.fn(async (_url, init) => { const request = body(init); return new Response(JSON.stringify({ accountId, session: { ...request.session, milliseconds: 8000, revision: 2 } })); }));
 expect(await sendReadingSessions(store, session)).toBe(1);
 expect((await store.sessions.get(row.id))?.seconds).toBe(row.seconds);
});
it('retains uncertain reports on invalid receipts and owner/identity mismatch', async () => {
 await saveReadingSession(row, store);
 for (const change of [{ accountId: 'other' }, { session: null }, { milliseconds: 1 }, { milliseconds: 86400001 }, { milliseconds: 1.5 }, { revision: 0 }, { revision: 86400001 }, { deviceId: 'other' }, { version: '2' }, { day: '2026-11-14' }]) {
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => { const request = body(init); const result = { accountId, session: { ...request.session, revision: 1 } }; if ('accountId' in change) result.accountId = change.accountId!; else if ('session' in change) result.session = null; else Object.assign(result.session, change); return new Response(JSON.stringify(result)); }));
  await expect(sendReadingSessions(store, session)).rejects.toThrow('не подтвердил');
  expect((await store.outbox.toArray())[0].state).toBe('sending');
 }
});
it('stops a batch on auth/conflict/server errors and leaves the rest untouched', async () => {
 await saveReadingSession(row, store); await saveReadingSession({ ...row, id: crypto.randomUUID() }, store);
 for (const status of [401, 409, 503]) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'failed', message: 'Try again' } }), { status })));
  await expect(sendReadingSessions(store, session)).rejects.toThrow('Try again');
  expect(fetch).toHaveBeenCalledOnce();
  expect((await store.outbox.toArray()).map(op => op.state).sort()).toEqual(['pending', 'sending']);
 }
});
it('retains a confirmed operation when local acknowledgement fails and retries the same UUID', async () => {
 await saveReadingSession(row, store); const fail = () => { throw new Error('Disk full'); };
 store.outbox.hook('deleting', fail);
 try { await expect(sendReadingSessions(store, session)).rejects.toThrow('Disk full'); }
 finally { store.outbox.hook('deleting').unsubscribe(fail); }
 store.close(); await store.open();
 expect(await sendReadingSessions(store, session)).toBe(1);
 expect(vi.mocked(fetch).mock.calls.map(call => String(call[1]?.body))[0]).toBe(vi.mocked(fetch).mock.calls.map(call => String(call[1]?.body))[1]);
 expect(await store.outbox.count()).toBe(0);
});
it('coordinates two connections until local acknowledgement finishes and fails closed without locks', async () => {
 await saveReadingSession(row, store); const other = new LocalDatabase(store.name, store.scope);
 let finish!: () => void;
 const gate = new Promise<void>(resolve => { finish = resolve; });
 let deleting = false;
 const hold = () => { deleting = true; void Dexie.waitFor(gate); };
 store.outbox.hook('deleting', hold);
 const sending = sendReadingSessions(store, session);
 try {
  await vi.waitFor(() => expect(deleting).toBe(true));
  await expect(sendReadingSessions(other, session)).rejects.toThrow('другой вкладке');
 } finally { finish(); await sending; store.outbox.hook('deleting').unsubscribe(hold); other.close(); }
 vi.stubGlobal('navigator', {});
 await expect(sendReadingSessions(store, session)).rejects.toThrow('HTTPS');
});
it('refuses guest/changed ownership and ignores foreign operations', async () => {
 const guest = new LocalDatabase('reading-session-guest');
 await expect(sendReadingSessions(guest, session)).rejects.toThrow('Аккаунт');
 await expect(sendReadingSessions(store, { ...session, user: { ...session.user, id: 'other' } })).rejects.toThrow('Аккаунт');
 await saveReadingSession(row, store); await store.outbox.toCollection().modify({ scope: 'account:other' });
 expect(await sendReadingSessions(store, session)).toBe(0); expect(fetch).not.toHaveBeenCalled();
});
it('rolls back session and provenance together if queuing fails and validates durations', async () => {
 const fail = () => { throw new Error('Disk full'); }; store.outbox.hook('creating', fail);
 try { await expect(saveReadingSession(row, store)).rejects.toThrow('Disk full'); }
 finally { store.outbox.hook('creating').unsubscribe(fail); }
 expect(await store.sessions.count()).toBe(0); expect(await store.metadata.count()).toBe(0);
 for (const seconds of [NaN, Infinity, -1, 86400.001]) await expect(saveReadingSession({ ...row, seconds }, store)).rejects.toThrow('Некорректное');
});
it('bounds each explicit batch to fifty operations', async () => {
 for (let i = 0; i < 51; i++) await saveReadingSession({ ...row, id: crypto.randomUUID() }, store);
 expect(await sendReadingSessions(store, session)).toBe(50); expect(fetch).toHaveBeenCalledTimes(50);
 expect(await store.outbox.count()).toBe(1);
});
it('rejects malformed provenance, dates, IDs and durations rather than guessing a report', async () => {
 await saveReadingSession(row, store); const op = (await store.outbox.toArray())[0];
 if (op.change.type !== 'session.put') throw new Error('fixture');
 for (const change of [{ day: '2026-02-29' }, { day: '0000-01-01' }, { version: undefined }, { deviceId: crypto.randomUUID() }, { id: 'legacy' }, { seconds: 86401 }, { seconds: NaN }, { seconds: 0 }]) {
  expect(readingSessionReport({ ...op, change: { ...op.change, value: { ...op.change.value, ...change } } })).toBeUndefined();
 }
});
it('cancels an in-flight automatic batch and retries the exact uncertain snapshot', async () => {
 await saveReadingSession(row, store);
 const controller = new AbortController();
 const calls: string[] = [];
 vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
  calls.push(String(init?.body));
  return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
 }));
 const sending = sendReadingSessions(store, session, controller.signal);
 const rejected = expect(sending).rejects.toThrow();
 await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce()); controller.abort(); await rejected;
 expect((await store.outbox.toArray())[0].state).toBe('sending');
 await saveReadingSession({ ...row, seconds: 9 }, store);
 store.close(); await store.open();
 vi.stubGlobal('fetch', vi.fn(async (_url, init) => { calls.push(String(init?.body)); return receipt(init); }));
 expect(await sendReadingSessions(store, session)).toBe(2);
 expect(calls[1]).toBe(calls[0]); expect(JSON.parse(calls[2]).session.milliseconds).toBe(9000);
});
it('does not mark pending snapshots as sending after cancellation', async () => {
 await saveReadingSession(row, store); const controller = new AbortController(); controller.abort();
 await expect(sendReadingSessions(store, session, controller.signal)).rejects.toThrow();
 expect(fetch).not.toHaveBeenCalled(); expect((await store.outbox.toArray())[0].state).toBe('pending');
});
