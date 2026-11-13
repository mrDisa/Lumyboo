import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LocalDatabase, bookmarkId, toggleBookmark, deleteBookmark, savePosition } from './db';
import { forgetBookmarkChoice, rememberBookmarkChoice, sendBookmarkChoice } from './bookmark-choices';
import { loadAccountBookmarkState, type BookmarkChange } from './bookmarks';
const accountId = '00000000-0000-4000-8000-000000000001';
const store = new LocalDatabase('bookmark-choice-tests', `account:${accountId}`);
const session = { user: { id: accountId, email: 'a@example.test' }, csrfToken: 'csrf' };
const bookmark = { bookId: 'book', version: '1', chapter: 0, paragraph: 'p1', offset: .3, label: 'Chapter' };
const id = bookmarkId(bookmark);
const change: BookmarkChange = { operationId: crypto.randomUUID(), expectedRevision: 2, bookmark, deleted: false };
const receipt = (overrides = {}) => new Response(JSON.stringify({ accountId, bookmark: { ...bookmark, deleted: false, revision: 3, ...overrides } }));
const local = () => toggleBookmark({ ...bookmark, updatedAt: 'before' }, bookmark.label, store);
const send = () => sendBookmarkChoice(store, session, id, change.operationId);
beforeEach(async () => {
 const { locks } = await vi.importActual<{ locks: LockManager }>('node:worker_threads');
 const prefix = crypto.randomUUID();
 vi.stubGlobal('navigator', { locks: { request: (name: string, options: LockOptions, callback: LockGrantedCallback<unknown>) => locks.request(prefix + name, options, callback) } });
});
afterEach(async () => { vi.unstubAllGlobals(); await store.delete(); await store.open(); });

it('persists the exact mutation before sending and replays after a lost response/reopen', async () => {
 await local();
 await rememberBookmarkChoice(store, change);
 const saved = await store.bookmarkChoices.get(id);
 const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('Lost response')).mockImplementation(async () => receipt());
 vi.stubGlobal('fetch', fetcher);
 await expect(send()).rejects.toThrow('Lost response');
 store.close(); await store.open();
 expect(await store.bookmarkChoices.get(id)).toEqual(saved);
 await send();
 expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body);
 expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ accountId, ...change });
 expect(fetcher.mock.calls[0][0]).toBe('/api/v1/bookmarks/apply');
 expect(fetcher.mock.calls[0][1].headers.get('X-CSRF-Token')).toBe('csrf');
 expect(fetcher.mock.calls[0][1].cache).toBe('no-store');
 expect(await store.bookmarkChoices.count()).toBe(0);
 expect(await store.outbox.count()).toBe(0);
 expect(await store.bookmarks.count()).toBe(1);
});

it('acknowledges deletion without losing a bookmark recreated while sending', async () => {
 await local(); await deleteBookmark(id, store);
 const deletion = { ...change, deleted: true };
 await rememberBookmarkChoice(store, deletion);
 vi.stubGlobal('fetch', vi.fn(async () => { await local(); return receipt({ deleted: true }); }));
 await send();
 expect(await store.bookmarks.count()).toBe(1);
 expect((await store.outbox.toArray()).map(op => op.change.type)).toEqual(['bookmark.put']);
});

it('does not widen the acknowledgement boundary or overwrite newer local changes', async () => {
 await local(); await rememberBookmarkChoice(store, change);
 const saved = await store.bookmarkChoices.get(id);
 await deleteBookmark(id, store); await local(); // Same value but a newer queued operation.
 await rememberBookmarkChoice(store, change);
 expect(await store.bookmarkChoices.get(id)).toEqual(saved);
 await savePosition({ ...bookmark, updatedAt: 'later' }, store);
 vi.stubGlobal('fetch', vi.fn(async () => receipt()));
 await send();
 expect((await store.outbox.toArray()).map(op => op.change.type).sort()).toEqual(['bookmark.put', 'position.put']);
});

it('persists conflicts, blocks automatic retry and leaves local data on cancellation', async () => {
 await local(); await rememberBookmarkChoice(store, change);
 const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'bookmark_conflict', message: 'Compare again' } }), { status: 409 }));
 vi.stubGlobal('fetch', fetcher);
 await expect(send()).rejects.toMatchObject({ code: 'bookmark_conflict' });
 store.close(); await store.open();
 expect((await store.bookmarkChoices.get(id))?.conflict).toBe(true);
 await expect(send()).rejects.toThrow('Сравни');
 await rememberBookmarkChoice(store, change); // Does not reset conflict.
 await expect(send()).rejects.toThrow('Сравни');
 expect(fetcher).toHaveBeenCalledTimes(1);
 await forgetBookmarkChoice(store, id, change.operationId);
 expect(await store.outbox.count()).toBe(1);
 expect(await store.bookmarks.count()).toBe(1);
});

it('rejects guests, switched owners, missing choices and replacement before any request', async () => {
 const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
 await expect(rememberBookmarkChoice(new LocalDatabase('unused-guest'), change)).rejects.toThrow('Аккаунт');
 await expect(send()).rejects.toThrow('изменилось');
 await rememberBookmarkChoice(store, change);
 await expect(sendBookmarkChoice(store, { ...session, user: { ...session.user, id: 'other' } }, id, change.operationId)).rejects.toThrow('Аккаунт');
 await expect(rememberBookmarkChoice(store, { ...change, operationId: 'replacement' })).rejects.toThrow('незавершённое');
 await forgetBookmarkChoice(store, id, 'wrong-id');
 expect(await store.bookmarkChoices.count()).toBe(1);
 expect(fetcher).not.toHaveBeenCalled();
});

it('retains mutations on expired sessions, wrong owners and invalid receipts', async () => {
 await local(); await rememberBookmarkChoice(store, change);
 const saved = await store.bookmarkChoices.get(id);
 for (const response of [
  new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'Sign in' } }), { status: 401 }),
  new Response(JSON.stringify({ accountId: 'other', bookmark: { ...bookmark, revision: 3, deleted: false } })),
  receipt({ offset: .8 }), receipt({ label: 'Other' }), receipt({ deleted: true }), receipt({ revision: 4 }), receipt({ revision: 2 }),
 ]) {
  vi.stubGlobal('fetch', vi.fn(async () => response));
  await expect(send()).rejects.toThrow();
  expect(await store.bookmarkChoices.get(id)).toEqual(saved);
  expect(await store.outbox.count()).toBe(1);
 }
});

it('never sends if persisting fails and atomically rolls back a failed local acknowledgement', async () => {
 await local();
 const fetcher = vi.fn(async () => receipt()); vi.stubGlobal('fetch', fetcher);
 const fail = () => { throw new Error('Storage full'); };
 store.bookmarkChoices.hook('creating', fail);
 try { await expect(rememberBookmarkChoice(store, change)).rejects.toThrow('Storage full'); }
 finally { store.bookmarkChoices.hook('creating').unsubscribe(fail); }
 await expect(send()).rejects.toThrow('изменилось'); expect(fetcher).not.toHaveBeenCalled();
 await rememberBookmarkChoice(store, change);
 store.bookmarkChoices.hook('deleting', fail);
 try { await expect(send()).rejects.toThrow('Storage full'); }
 finally { store.bookmarkChoices.hook('deleting').unsubscribe(fail); }
 expect(await store.outbox.count()).toBe(1);
 expect(await store.bookmarkChoices.count()).toBe(1);
 await send();
 expect(await store.outbox.count()).toBe(0);
 expect(await store.bookmarkChoices.count()).toBe(0);
});

it('blocks concurrent sends/cancellation/replacement across database connections', async () => {
 const other = new LocalDatabase(store.name, store.scope);
 let finish!: (response: Response) => void;
 const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })); vi.stubGlobal('fetch', fetcher);
 await rememberBookmarkChoice(store, change);
 const sending = send();
 try {
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  await expect(sendBookmarkChoice(other, session, id, change.operationId)).rejects.toThrow('другой вкладке');
  await expect(forgetBookmarkChoice(other, id, change.operationId)).rejects.toThrow('другой вкладке');
  await expect(rememberBookmarkChoice(other, { ...change, operationId: 'replacement' })).rejects.toThrow('другой вкладке');
  await rememberBookmarkChoice(other, { ...change, bookmark: { ...bookmark, paragraph: 'p2' } });
  expect(fetcher).toHaveBeenCalledOnce();
 } finally { finish(receipt()); await sending; other.close(); }
 await rememberBookmarkChoice(store, change); // Lock released after commit.
});

it('holds the lock through the local acknowledgement transaction', async () => {
 await rememberBookmarkChoice(store, change);
 vi.stubGlobal('fetch', vi.fn(async () => receipt()));
 let release!: () => void;
 const held = new Promise<void>(resolve => { release = resolve; });
 let committing = false;
 const hold = () => { committing = true; void Dexie.waitFor(held); };
 store.bookmarkChoices.hook('deleting', hold);
 const sending = send();
 try {
  await vi.waitFor(() => expect(committing).toBe(true));
  await expect(forgetBookmarkChoice(store, id, change.operationId)).rejects.toThrow('другой вкладке');
 } finally { release(); await sending; store.bookmarkChoices.hook('deleting').unsubscribe(hold); }
 expect(await store.bookmarkChoices.count()).toBe(0);
});

it('fails closed without Web Locks and retains the saved request', async () => {
 await rememberBookmarkChoice(store, change);
 vi.stubGlobal('navigator', {});
 const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
 await expect(send()).rejects.toThrow('HTTPS');
 await expect(forgetBookmarkChoice(store, id, change.operationId)).rejects.toThrow('HTTPS');
 expect(await store.bookmarkChoices.count()).toBe(1);
 expect(fetcher).not.toHaveBeenCalled();
});

it('upgrades v4 preserving existing choices, bookmarks and pending operations', async () => {
 await store.delete();
 const old = new Dexie(store.name);
 old.version(4).stores({ settings: 'id', positions: 'bookId', bookmarks: 'id, bookId', shelf: 'bookId', downloads: 'bookId', sessions: 'id, day, bookId', positionHistory: 'id, bookId, [bookId+version]', outbox: 'id, sequence, [entity+state]', metadata: 'id', positionChoices: 'bookId' });
 await old.table('bookmarks').put({ ...bookmark, id, updatedAt: 'before' });
 await old.table('positionChoices').put({ bookId: 'book', conflict: true });
 await old.table('outbox').put({ id: 'existing', sequence: 1, scope: store.scope, change: { type: 'session.put', key: 's' } });
 old.close(); await store.open();
 await rememberBookmarkChoice(store, change);
 expect(await store.bookmarks.count()).toBe(1);
 expect(await store.positionChoices.get('book')).toEqual({ bookId: 'book', conflict: true });
 expect((await store.outbox.toArray()).map(op => op.id)).toEqual(['existing']);
});

it('loads revisioned state including tombstones with account ownership checks', async () => {
 const fetcher = vi.fn(async (_url: string) => new Response(JSON.stringify({ accountId, bookmarks: [{ ...bookmark, revision: 3, deleted: true }] })));
 vi.stubGlobal('fetch', fetcher);
 expect((await loadAccountBookmarkState(accountId)).bookmarks[0].deleted).toBe(true);
 expect(fetcher.mock.calls[0][0]).toBe('/api/v1/bookmarks/state');
 await expect(loadAccountBookmarkState('other')).rejects.toMatchObject({ code: 'account_changed' });
});

it('keeps newer deletion during a put and does not clear another account queue', async () => {
 const other = new LocalDatabase('bookmark-other-account', 'account:other');
 try {
  await local();
  await toggleBookmark({ ...bookmark, updatedAt: 'before' }, bookmark.label, other);
  await rememberBookmarkChoice(other, change);
  await rememberBookmarkChoice(store, change);
  vi.stubGlobal('fetch', vi.fn(async () => { await deleteBookmark(id, store); return receipt(); }));
  await send();
  expect(await store.bookmarks.count()).toBe(0);
  expect((await store.outbox.toArray()).map(op => op.change.type)).toEqual(['bookmark.delete']);
  expect(await other.bookmarkChoices.count()).toBe(1);
  expect(await other.outbox.count()).toBe(1);
 } finally { await other.delete(); }
});

it('leaves mismatching snapshots queued and permits cancellation after an uncertain request', async () => {
 await local();
 await rememberBookmarkChoice(store, { ...change, bookmark: { ...bookmark, label: 'Reviewed server label' } });
 expect((await store.bookmarkChoices.get(id))?.coveredOperationIds).toEqual([]);
 vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Lost response'); }));
 await expect(send()).rejects.toThrow('Lost response');
 await forgetBookmarkChoice(store, id, change.operationId);
 expect(await store.outbox.count()).toBe(1);
 expect((await store.bookmarks.get(id))?.label).toBe(bookmark.label);
});
