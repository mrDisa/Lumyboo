import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LocalDatabase, savePosition, toggleBookmark, saveReadingSession } from './db';
import { acceptPositionDownload, reviewPositionDownload } from './position-download';
import { rememberPositionChoice, sendPositionChoice } from './position-choices';
import { positionChoice } from './positions';
import { readingLockName } from './reading-ownership';
import type { BookContent } from './books';
const accountId = '00000000-0000-4000-8000-000000000001';
const store = new LocalDatabase('position-download-tests', `account:${accountId}`);
const session = { user: { id: accountId, email: 'a@example.test' }, csrfToken: 'csrf' };
const content: BookContent = { id: 'book', version: '1', chapters: [{ id: 'c1', title: 'Chapter', paragraphs: [{ id: 'p1', text: 'First' }] }] };
const remote = { bookId: 'book', version: '1', chapter: 0, paragraph: 'p1', offset: .3, revision: 3 };
const local = { ...remote, offset: .7, updatedAt: 'before' };
const review = () => reviewPositionDownload(store, accountId, remote);
beforeEach(async () => {
 const { locks } = await vi.importActual<{ locks: LockManager }>('node:worker_threads');
 const prefix = crypto.randomUUID();
 vi.stubGlobal('navigator', { locks: { request: (name: string, options: LockOptions, callback: LockGrantedCallback<unknown>) => locks.request(prefix + name, options, callback) } });
 vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(session))));
});
afterEach(async () => { vi.unstubAllGlobals(); await store.delete(); await store.open(); });
it('receives a server-only place without an outgoing echo and survives reopen', async () => {
 await acceptPositionDownload(store, await review(), content);
 store.close(); await store.open();
 expect(await store.positions.get('book')).toMatchObject({ offset: .3 });
 expect(await store.positionHistory.count()).toBe(0);
 expect(await store.outbox.count()).toBe(0);
 expect(vi.mocked(fetch).mock.calls.map(call => call[0])).toEqual(['/api/v1/auth/session']);
});
it('archives the old place and supersedes only its reviewed operations, keeping other data', async () => {
 await savePosition(local, store);
 await savePosition({ ...local, bookId: 'other' }, store);
 await toggleBookmark(local, 'Keep', store);
 await saveReadingSession({ id: 'session', bookId: 'book', seconds: 20, day: '2026-11-13' }, store);
 const ops = await store.outbox.toArray();
 await acceptPositionDownload(store, await review(), content);
 expect(await store.positionHistory.toArray()).toEqual([expect.objectContaining(local)]);
 expect(await store.outbox.toArray()).toEqual(ops.filter(op => op.entity !== 'position:book'));
 expect(await store.bookmarks.count()).toBe(1);
 expect(await store.sessions.count()).toBe(1);
 expect((await store.positions.get('other'))?.offset).toBe(.7);
});
it('rejects later reading, deletion and identical recreation from a second connection', async () => {
 const other = new LocalDatabase(store.name, store.scope);
 try {
  const absent = await review();
  await savePosition(local, other);
  await expect(acceptPositionDownload(store, absent, content)).rejects.toThrow('изменилось');
  const present = await review();
  await savePosition({ ...local, offset: .8 }, other);
  await savePosition(local, other);
  expect(await store.positions.get('book')).toEqual(present.local);
  await expect(acceptPositionDownload(store, present, content)).rejects.toThrow('изменилось');
  const recreated = await review();
  await other.positions.delete('book');
  await expect(acceptPositionDownload(store, recreated, content)).rejects.toThrow('изменилось');
  expect(await store.positionHistory.count()).toBe(0);
  expect(await store.outbox.count()).toBe(1);
 } finally { other.close(); }
});
it('rejects unresolved choices before and after comparison, including conflicts without outbox', async () => {
 const download = await review();
 await rememberPositionChoice(store, { bookId: 'book', choice: positionChoice(local, remote), remote, conflict: false });
 await store.positionChoices.update('book', { conflict: true });
 await expect(review()).rejects.toThrow('незавершённое');
 await expect(acceptPositionDownload(store, download, content)).rejects.toThrow('незавершённое');
 expect(await store.positions.count()).toBe(0);
 expect(await store.positionChoices.count()).toBe(1);
});
it('keeps the position and queue on expired, changed or unavailable session', async () => {
 await savePosition(local, store); const download = await review(); const ops = await store.outbox.toArray();
 for (const response of [new Response('{}', { status: 401 }), new Response(JSON.stringify({ ...session, user: { ...session.user, id: 'other' } })), new Response('{}', { status: 503 })]) {
  vi.stubGlobal('fetch', vi.fn(async () => response));
  await expect(acceptPositionDownload(store, download, content)).rejects.toThrow();
  expect(await store.positions.get('book')).toEqual(local);
  expect(await store.outbox.toArray()).toEqual(ops);
  expect(await store.positionHistory.count()).toBe(0);
 }
});
it('rejects guest/other ownership, invalid edition and locators without a request', async () => {
 const download = await review();
 const guest = new LocalDatabase('position-unused-guest');
 await expect(reviewPositionDownload(guest, accountId, remote)).rejects.toThrow('Аккаунт');
 await expect(acceptPositionDownload(guest, download, content)).rejects.toThrow('Аккаунт');
 for (const change of [{ bookId: 'other' }, { version: '2' }, { paragraph: 'missing' }, { offset: 1 }]) {
  await expect(acceptPositionDownload(store, { ...download, remote: { ...remote, ...change } }, content)).rejects.toThrow('изданию');
 }
 expect(fetch).not.toHaveBeenCalled();
});
it('rolls back history, position and queue together on storage failure', async () => {
 await savePosition(local, store); const download = await review(); const ops = await store.outbox.toArray();
 const fail = () => { throw new Error('Disk full'); };
 store.outbox.hook('deleting', fail);
 try { await expect(acceptPositionDownload(store, download, content)).rejects.toThrow('Disk full'); }
 finally { store.outbox.hook('deleting').unsubscribe(fail); }
 expect(await store.positions.get('book')).toEqual(local);
 expect(await store.outbox.toArray()).toEqual(ops);
 expect(await store.positionHistory.count()).toBe(0);
 await acceptPositionDownload(store, download, content);
 expect((await store.positions.get('book'))?.offset).toBe(.3);
});
it('blocks adoption while reading and fails closed without Web Locks', async () => {
 const download = await review();
 await navigator.locks.request(readingLockName(store.scope, 'book'), async () => {
  await expect(acceptPositionDownload(store, download, content)).rejects.toThrow('закрой читалку');
 });
 vi.stubGlobal('navigator', {});
 await expect(acceptPositionDownload(store, download, content)).rejects.toThrow('HTTPS');
 expect(await store.positions.count()).toBe(0);
});
it('coordinates receiving with in-flight position choices', async () => {
 const download = await review();
 const choice = positionChoice(local, remote);
 await rememberPositionChoice(store, { bookId: 'book', choice, remote, conflict: false });
 let finish!: (response: Response) => void;
 const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
 vi.stubGlobal('fetch', fetcher);
 const sending = sendPositionChoice(store, session, 'book', choice.operationId);
 try {
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  await expect(acceptPositionDownload(store, download, content)).rejects.toThrow('другой вкладке');
 } finally { finish(new Response(JSON.stringify({ accountId, position: { ...local, revision: 4 } }))); await sending; }
 expect(await store.positions.count()).toBe(0);
});
it('refuses sending operations both at comparison and after it', async () => {
 await savePosition(local, store); const download = await review();
 await store.outbox.toCollection().modify({ state: 'sending' });
 await expect(review()).rejects.toThrow('отправляется');
 await expect(acceptPositionDownload(store, download, content)).rejects.toThrow('изменилось');
 expect(await store.positions.get('book')).toEqual(local);
});
