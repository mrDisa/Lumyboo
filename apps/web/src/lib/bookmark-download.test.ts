import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LocalDatabase, bookmarkId, toggleBookmark, deleteBookmark, savePosition } from './db';
import { acceptBookmarkDownload, reviewBookmarkDownload } from './bookmark-download';
import { rememberBookmarkChoice, sendBookmarkChoice } from './bookmark-choices';
import { readingLockName } from './reading-ownership';
import type { BookContent } from './books';
const accountId = '00000000-0000-4000-8000-000000000001';
const store = new LocalDatabase('bookmark-download-tests', `account:${accountId}`);
const session = { user: { id: accountId, email: 'a@example.test' }, csrfToken: 'csrf' };
const content: BookContent = { id: 'book', version: '1', chapters: [{ id: 'c1', title: 'Chapter', paragraphs: [{ id: 'p1', text: 'First' }] }] };
const remote = { bookId: 'book', version: '1', chapter: 0, paragraph: 'p1', offset: .3, label: 'Server', revision: 3, deleted: false };
const id = bookmarkId(remote);
const local = () => toggleBookmark({ ...remote, updatedAt: 'before' }, 'Device', store);
const review = () => reviewBookmarkDownload(store, accountId, remote);
beforeEach(async () => {
 const { locks } = await vi.importActual<{ locks: LockManager }>('node:worker_threads');
 const prefix = crypto.randomUUID();
 vi.stubGlobal('navigator', { locks: { request: (name: string, options: LockOptions, callback: LockGrantedCallback<unknown>) => locks.request(prefix + name, options, callback) } });
 vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(session))));
});
afterEach(async () => { vi.unstubAllGlobals(); await store.delete(); await store.open(); });

it('receives a reviewed server-only bookmark without an outgoing echo and survives reopen', async () => {
 const choice = await review();
 expect(await store.bookmarks.count()).toBe(0);
 await acceptBookmarkDownload(store, choice, content);
 store.close(); await store.open();
 expect(await store.bookmarks.get(id)).toMatchObject({ label: 'Server', offset: .3 });
 expect(await store.outbox.count()).toBe(0);
 expect(vi.mocked(fetch).mock.calls.map(call => call[0])).toEqual(['/api/v1/auth/session']);
});
it('explicitly supersedes only the reviewed bookmark operations, preserving other data', async () => {
 await local(); await deleteBookmark(id, store);
 await savePosition({ ...remote, updatedAt: 'before' }, store);
 const unrelated = await store.outbox.toArray();
 await acceptBookmarkDownload(store, await review(), content);
 expect((await store.bookmarks.get(id))?.label).toBe('Server');
 expect(await store.outbox.toArray()).toEqual(unrelated.filter(op => op.change.type === 'position.put'));
 const deletion = await reviewBookmarkDownload(store, accountId, { ...remote, deleted: true });
 await acceptBookmarkDownload(store, deletion, content);
 expect(await store.bookmarks.count()).toBe(0);
 expect(await store.outbox.count()).toBe(1);
});
it('rejects later local creation, deletion, editing and identical recreation from a second connection', async () => {
 const other = new LocalDatabase(store.name, store.scope);
 try {
  const absent = await review();
  await local();
  await expect(acceptBookmarkDownload(store, absent, content)).rejects.toThrow('изменилась');
  const present = await review();
  await deleteBookmark(id, other);
  await expect(acceptBookmarkDownload(store, present, content)).rejects.toThrow('изменилась');
  await local();
  // Exactly the same value/timestamp still carries a new operation boundary.
  expect(await store.bookmarks.get(id)).toEqual(present.local);
  await expect(acceptBookmarkDownload(store, present, content)).rejects.toThrow('изменилась');
  const edited = await review();
  await other.bookmarks.update(id, { label: 'Later' });
  await expect(acceptBookmarkDownload(store, edited, content)).rejects.toThrow('изменилась');
  expect((await store.bookmarks.get(id))?.label).toBe('Later');
  expect(await store.outbox.count()).toBe(1);
 } finally { other.close(); }
});
it('rejects unresolved changes created before or after comparison, including conflicts without outbox', async () => {
 const choice = await review();
 await rememberBookmarkChoice(store, { operationId: crypto.randomUUID(), expectedRevision: 3, bookmark: remote, deleted: true });
 await store.bookmarkChoices.update(id, { conflict: true });
 await expect(review()).rejects.toThrow('незавершённое');
 await expect(acceptBookmarkDownload(store, choice, content)).rejects.toThrow('незавершённое');
 expect(await store.bookmarks.count()).toBe(0);
 expect(await store.bookmarkChoices.count()).toBe(1);
});
it('keeps data and queue when the live session expires, changes owner or cannot be checked', async () => {
 await local(); const choice = await review(); const ops = await store.outbox.toArray();
 for (const response of [new Response('{}', { status: 401 }), new Response(JSON.stringify({ ...session, user: { ...session.user, id: 'other' } })), new Response('{}', { status: 503 })]) {
  vi.stubGlobal('fetch', vi.fn(async () => response));
  await expect(acceptBookmarkDownload(store, choice, content)).rejects.toThrow();
  expect(await store.bookmarks.get(id)).toEqual(choice.local);
  expect(await store.outbox.toArray()).toEqual(ops);
 }
});
it('rejects guest/other stores and invalid edition/locator without a request', async () => {
 const choice = await review();
 const guest = new LocalDatabase('download-unused-guest');
 await expect(reviewBookmarkDownload(guest, accountId, remote)).rejects.toThrow('Аккаунт');
 await expect(acceptBookmarkDownload(guest, choice, content)).rejects.toThrow('Аккаунт');
 for (const change of [{ version: '2' }, { paragraph: 'missing' }, { offset: 1 }]) {
  await expect(acceptBookmarkDownload(store, { ...choice, remote: { ...remote, ...change } }, content)).rejects.toThrow('изданию');
 }
 expect(fetch).not.toHaveBeenCalled();
});
it('rolls back bookmark and queue together on storage failure', async () => {
 await local(); const choice = await review(); const ops = await store.outbox.toArray();
 const fail = () => { throw new Error('Disk full'); };
 store.outbox.hook('deleting', fail);
 try { await expect(acceptBookmarkDownload(store, choice, content)).rejects.toThrow('Disk full'); }
 finally { store.outbox.hook('deleting').unsubscribe(fail); }
 expect(await store.bookmarks.get(id)).toEqual(choice.local);
 expect(await store.outbox.toArray()).toEqual(ops);
 await acceptBookmarkDownload(store, choice, content);
 expect((await store.bookmarks.get(id))?.label).toBe('Server');
});
it('blocks adoption while the reader owns the book and fails closed without Locks', async () => {
 const choice = await review();
 await navigator.locks.request(readingLockName(store.scope, remote.bookId), async () => {
  await expect(acceptBookmarkDownload(store, choice, content)).rejects.toThrow('закрой читалку');
 });
 vi.stubGlobal('navigator', {});
 await expect(acceptBookmarkDownload(store, choice, content)).rejects.toThrow('HTTPS');
 expect(await store.bookmarks.count()).toBe(0);
});
it('coordinates with in-flight bookmark mutations through the same lock', async () => {
 const choice = await review();
 const operationId = crypto.randomUUID();
 await rememberBookmarkChoice(store, { operationId, expectedRevision: 3, bookmark: remote, deleted: true });
 let finish!: (response: Response) => void;
 const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
 vi.stubGlobal('fetch', fetcher);
 const sending = sendBookmarkChoice(store, session, id, operationId);
 try {
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  await expect(acceptBookmarkDownload(store, choice, content)).rejects.toThrow('другой вкладке');
 } finally { finish(new Response(JSON.stringify({ accountId, bookmark: { ...remote, revision: 4, deleted: true } }))); await sending; }
 expect(await store.bookmarks.count()).toBe(0);
});
