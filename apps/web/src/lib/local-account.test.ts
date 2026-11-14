import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getSession } from './auth';
import { accountDatabase, resumeLocalAccountBook } from './account-reading';
import { db, savePosition, toggleBookmark, saveReadingSession } from './db';
import { authChangeKey, readLocalAccount, rememberLocalAccount, isConnectionFailure } from './local-account';
import { ApiError } from './api';
import type { BookContent } from './books';
const user = { id: '00000000-0000-4000-8000-000000000001', email: 'a@example.test' };
const other = { id: '00000000-0000-4000-8000-000000000002', email: 'b@example.test' };
const content: BookContent = { id: 'book', version: '1', chapters: [{ id: 'c', title: 'Chapter', paragraphs: [{ id: 'p', text: 'Text' }] }] };
const position = { bookId: 'book', version: '1', chapter: 0, paragraph: 'p', offset: .2, updatedAt: 'before' };
const store = accountDatabase(user.id);
function serverSession(value = user) { return new Response(JSON.stringify({ user: value, csrfToken: 'secret' })); }
beforeEach(async () => {
 const values = new Map<string, string>();
 vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
 const { locks } = await vi.importActual<{ locks: LockManager }>('node:worker_threads');
 vi.stubGlobal('navigator', { locks });
});
afterEach(async () => { vi.unstubAllGlobals(); for (const source of [store, db]) { await source.delete(); await source.open(); } });
it('retains just the verified identity across a network failure, never the CSRF token', async () => {
 const fetcher = vi.fn().mockResolvedValueOnce(serverSession()).mockRejectedValue(new TypeError('offline'));
 vi.stubGlobal('fetch', fetcher);
 await getSession();
 expect(localStorage.getItem('lumyboo-local-account')).toBe(JSON.stringify(user));
 await expect(getSession()).rejects.toBeInstanceOf(TypeError);
 expect(readLocalAccount()).toEqual(user);
});
it('reopens only the last verified account without making any server request or changing its queues', async () => {
 vi.stubGlobal('fetch', vi.fn().mockResolvedValue(serverSession())); await getSession();
 await savePosition(position, store); await toggleBookmark(position, 'Private', store);
 await saveReadingSession({ id: 's', bookId: 'book', day: '2026-11-14', seconds: 3 }, store);
 store.close(); await store.open();
 const before = await Promise.all(store.tables.map(table => table.toArray()));
 const fetcher = vi.fn().mockRejectedValue(new TypeError('offline')); vi.stubGlobal('fetch', fetcher);
 await resumeLocalAccountBook(store, content, true);
 expect(fetcher).not.toHaveBeenCalled();
 expect(await Promise.all(store.tables.map(table => table.toArray()))).toEqual(before);
 expect(await db.positions.count()).toBe(0);
 // Offline edits remain owned and queued for this account after another reopen.
 await savePosition({ ...position, offset: .6 }, store);
 store.close(); await store.open();
 expect((await store.positions.get('book'))?.offset).toBe(.6);
 expect((await store.outbox.toArray()).every(op => op.scope === `account:${user.id}`)).toBe(true);
 rememberLocalAccount(other);
 await expect(resumeLocalAccountBook(store, content, true)).rejects.toThrow('Аккаунт изменился');
 rememberLocalAccount(null);
 await expect(resumeLocalAccountBook(store, content, true)).rejects.toThrow('Вход истёк');
});
it('revokes local reopening after a definitive 401 and replaces it on a new account login', async () => {
 vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(serverSession()).mockResolvedValueOnce(new Response('{}', { status: 401 })).mockResolvedValueOnce(serverSession(other)));
 await getSession(); expect(readLocalAccount()).toEqual(user);
 expect(await getSession()).toBeNull(); expect(readLocalAccount()).toBeNull();
 await getSession(); expect(readLocalAccount()).toEqual(other);
});
it('does not revive access with a delayed session response after logout in another tab', async () => {
 let resolve!: (response: Response) => void;
 vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise<Response>(done => { resolve = done; })));
 const checking = getSession();
 localStorage.setItem(authChangeKey, 'logout-from-another-tab'); rememberLocalAccount(null);
 resolve(serverSession());
 await expect(checking).rejects.toThrow('Аккаунт изменился');
 expect(readLocalAccount()).toBeNull();
});
it('refuses missing, corrupt and mismatched local places without using guest data', async () => {
 rememberLocalAccount(user);
 await savePosition(position, db);
 await expect(resumeLocalAccountBook(db, content, true)).rejects.toThrow('отдельное хранилище');
 await expect(resumeLocalAccountBook(store, content, true)).rejects.toThrow('нет места');
 await savePosition({ ...position, version: 'old' }, store);
 await expect(resumeLocalAccountBook(store, content, true)).rejects.toThrow('нет места');
 localStorage.setItem('lumyboo-local-account', '{bad'); expect(readLocalAccount()).toBeNull();
 localStorage.setItem('lumyboo-local-account', JSON.stringify({ id: '../another', email: 'x' })); expect(readLocalAccount()).toBeNull();
});
it('permits fallback only for connection failures, never a server rejection or cancellation', () => {
 expect(isConnectionFailure(new TypeError('network'))).toBe(true);
 expect(isConnectionFailure(new DOMException('timeout', 'TimeoutError'))).toBe(true);
 for (const error of [new ApiError('expired', 401, 'unauthorized'), new ApiError('failed', 503, 'unavailable'), new DOMException('cancelled', 'AbortError'), new SyntaxError('bad response')]) expect(isConnectionFailure(error)).toBe(false);
});
