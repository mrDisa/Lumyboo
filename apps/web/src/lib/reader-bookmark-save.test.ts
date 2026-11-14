import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bookmarkId, LocalDatabase, toggleBookmark, deleteBookmark } from './db';
import { createReaderBookmarkSave } from './reader-bookmark-save';
import type { BookContent } from './books';
import type { BookmarkChange, BookmarkState } from './bookmarks';
const accountId = '00000000-0000-4000-8000-000000000001';
const store = new LocalDatabase('reader-bookmark-save-tests', `account:${accountId}`);
const session = { user: { id: accountId, email: 'a@example.test' }, csrfToken: 'csrf' };
const local = { bookId: 'book', version: '1', chapter: 0, paragraph: 'p1', offset: .6, updatedAt: 'today' };
const entry = { ...local, label: 'Text' };
const remote: BookmarkState = { ...entry, revision: 4, deleted: false };
const content = { id: 'book', version: '1', chapters: [{ paragraphs: [{ id: 'p1', text: 'Text' }, { id: 'p2', text: 'More' }] }] } as BookContent;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
let bodies: (BookmarkChange & { accountId: string })[];
beforeEach(async () => {
 const { locks } = await vi.importActual<{ locks: LockManager }>('node:worker_threads');
 const prefix = crypto.randomUUID();
 vi.stubGlobal('navigator', { locks: { request: (name: string, options: LockOptions, cb: LockGrantedCallback<unknown>) => locks.request(prefix + name, options, cb) } });
 bodies = [];
 vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
  if (url.endsWith('/auth/session')) return json(session);
  const body = JSON.parse(options!.body as string); bodies.push(body);
  return json({ accountId, bookmark: { ...body.bookmark, deleted: body.deleted, revision: body.expectedRevision + 1 } });
 }));
});
afterEach(async () => { vi.unstubAllGlobals(); await store.delete(); await store.open(); });
it('saves a new bookmark against revision zero and leaves other data alone', async () => {
 const save = await createReaderBookmarkSave(store, content, []);
 await toggleBookmark(local, 'Text', store);
 await toggleBookmark({ ...local, bookId: 'other' }, 'Other', store);
 await save();
 expect(bodies).toHaveLength(1);
 expect(bodies[0]).toMatchObject({ accountId, expectedRevision: 0, deleted: false, bookmark: { paragraph: 'p1', label: 'Text' } });
 expect(await store.outbox.count()).toBe(1);
 expect(await store.bookmarks.count()).toBe(2);
 await save(); expect(bodies).toHaveLength(1);
});
it('deletes using the opening locator and revision, including after reopen', async () => {
 await store.bookmarks.put({ ...entry, id: bookmarkId(entry) });
 const save = await createReaderBookmarkSave(store, content, [remote]);
 await deleteBookmark(bookmarkId(entry), store);
 store.close(); await store.open(); await save();
 expect(bodies[0]).toMatchObject({ expectedRevision: 4, deleted: true, bookmark: { label: 'Text', offset: .6 } });
 expect(await store.outbox.count()).toBe(0);
 expect(await store.bookmarks.count()).toBe(0);
});
it('restores a tombstone using its opening revision', async () => {
 const save = await createReaderBookmarkSave(store, content, [{ ...remote, deleted: true }]);
 await toggleBookmark(local, 'Text', store); await save();
 expect(bodies[0]).toMatchObject({ expectedRevision: 4, deleted: false });
});
it('retries exact persisted changes after lost response without resending completed bookmarks', async () => {
 const save = await createReaderBookmarkSave(store, content, []);
 await toggleBookmark(local, 'Text', store);
 await toggleBookmark({ ...local, paragraph: 'p2' }, 'More', store);
 const fetcher = fetch;
 let lost = false;
 vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
  const response = await fetcher(url, options);
  if (!url.endsWith('/auth/session') && JSON.parse(options!.body as string).bookmark.paragraph === 'p2' && !lost) { lost = true; throw new TypeError('Lost response'); }
  return response;
 }));
 await expect(save()).rejects.toThrow('Не удалось связаться с сервисом');
 expect(await store.bookmarkChoices.count()).toBe(1);
 store.close(); await store.open(); await save();
 expect(bodies).toHaveLength(3); expect(bodies[2]).toEqual(bodies[1]);
 expect(await store.bookmarkChoices.count()).toBe(0); expect(await store.outbox.count()).toBe(0);
});
it('keeps conflicts and blocks retries without fetching a replacement revision', async () => {
 const save = await createReaderBookmarkSave(store, content, [remote]);
 await toggleBookmark(local, 'Text', store);
 const fetcher = vi.fn(async (url: string) => url.endsWith('/auth/session') ? json(session) : json({ error: { code: 'bookmark_conflict', message: 'Compare again' } }, 409));
 vi.stubGlobal('fetch', fetcher);
 await expect(save()).rejects.toMatchObject({ code: 'bookmark_conflict' });
 await expect(save()).rejects.toThrow('Сравни');
 expect(fetcher.mock.calls.filter(([url]) => !url.endsWith('/auth/session'))).toHaveLength(1);
 expect((await store.bookmarkChoices.get(bookmarkId(entry)))?.conflict).toBe(true);
 expect(await store.outbox.count()).toBe(1); expect(await store.bookmarks.count()).toBe(1);
});
it('does not silently send edits from before reading, even if edited again', async () => {
 await toggleBookmark(local, 'Old', store);
 const save = await createReaderBookmarkSave(store, content, [remote]);
 await deleteBookmark(bookmarkId(entry), store);
 await expect(save()).rejects.toThrow('прежнее');
 expect(bodies).toHaveLength(0); expect(await store.outbox.count()).toBe(1);
});
it('preserves an older unresolved choice and refuses to send it automatically', async () => {
 const save = await createReaderBookmarkSave(store, content, []);
 await toggleBookmark(local, 'Text', store);
 await store.bookmarkChoices.put({ id: bookmarkId(entry), conflict: false, coveredOperationIds: [], change: { operationId: 'old', expectedRevision: 2, bookmark: entry, deleted: false } });
 await expect(save()).rejects.toThrow('прежнее'); expect(bodies).toHaveLength(0);
 expect((await store.bookmarkChoices.get(bookmarkId(entry)))?.change.operationId).toBe('old');
});
it('does not invent a deletion for a bookmark added and removed while reading', async () => {
 const save = await createReaderBookmarkSave(store, content, []);
 await toggleBookmark(local, 'Text', store); await toggleBookmark(local, 'Text', store);
 await save(); expect(bodies).toHaveLength(0); expect(await store.outbox.count()).toBe(0);
});
it('refuses expired sessions and switched owners before writing choices', async () => {
 const save = await createReaderBookmarkSave(store, content, []);
 await toggleBookmark(local, 'Text', store);
 vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ error: { code: 'unauthorized', message: 'Expired' } }, 401)).mockResolvedValueOnce(json({ ...session, user: { ...session.user, id: 'other' } })));
 await expect(save()).rejects.toThrow('Вход истёк'); await expect(save()).rejects.toThrow('Аккаунт изменился');
 expect(await store.bookmarkChoices.count()).toBe(0); expect(await store.outbox.count()).toBe(1);
});
it('keeps the operation when persisting the exact request fails', async () => {
 const save = await createReaderBookmarkSave(store, content, []);
 await toggleBookmark(local, 'Text', store);
 const fail = () => { throw new Error('Storage full'); }; store.bookmarkChoices.hook('creating', fail);
 try { await expect(save()).rejects.toThrow('Storage full'); } finally { store.bookmarkChoices.hook('creating').unsubscribe(fail); }
 expect(bodies).toHaveLength(0); expect(await store.outbox.count()).toBe(1);
 await save(); expect(bodies).toHaveLength(1);
});
