import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LocalDatabase, savePosition, toggleBookmark, saveReadingSession } from './db';
import { reviewPositionRestore, restoreHistoricalPosition } from './position-history';
import { rememberPositionChoice, withPositionChoiceLock } from './position-choices';
import { positionChoice } from './positions';
import { readingLockName } from './reading-ownership';
import type { BookContent } from './books';
const accountId = '00000000-0000-4000-8000-000000000001';
const store = new LocalDatabase('position-history-tests', `account:${accountId}`);
const content: BookContent = { id: 'book', version: '1', chapters: [{ id: 'c1', title: 'Chapter', paragraphs: [{ id: 'p1', text: 'First' }] }] };
const historical = { id: 'saved', bookId: 'book', version: '1', chapter: 0, paragraph: 'p1', offset: .3, updatedAt: 'before' };
const local = { bookId: 'book', version: '1', chapter: 0, paragraph: 'p1', offset: .7, updatedAt: 'now' };
const review = () => reviewPositionRestore(store, accountId, 'saved');
beforeEach(async () => {
 const { locks } = await vi.importActual<{ locks: LockManager }>('node:worker_threads');
 const prefix = crypto.randomUUID();
 vi.stubGlobal('navigator', { locks: { request: (name: string, options: LockOptions, callback: LockGrantedCallback<unknown>) => locks.request(prefix + name, options, callback) } });
 vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ user: { id: accountId, email: 'a@example.test' }, csrfToken: 'csrf' }))));
 await store.positionHistory.put(historical);
});
afterEach(async () => { vi.unstubAllGlobals(); await store.delete(); await store.open(); });
it('restores after reopen as a new local edit, keeps history and unrelated data', async () => {
 await savePosition(local, store);
 await savePosition({ ...local, bookId: 'other' }, store);
 await toggleBookmark(local, 'Keep', store);
 await saveReadingSession({ id: 'session', bookId: 'book', seconds: 20, day: '2026-11-13' }, store);
 const unrelated = (await store.outbox.toArray()).filter(op => op.entity !== 'position:book');
 const comparison = await review();
 store.close(); await store.open();
 await restoreHistoricalPosition(store, comparison, content);
 store.close(); await store.open();
 const restored = await store.positions.get('book');
 expect(restored).toMatchObject({ offset: .3 });
 expect(restored).not.toHaveProperty('id');
 expect(await store.positionHistory.get('saved')).toEqual(historical);
 expect(await store.positionHistory.toArray()).toContainEqual(expect.objectContaining(local));
 const operations = await store.outbox.toArray();
 expect(operations.filter(op => op.entity !== 'position:book')).toEqual(unrelated);
 expect(operations.filter(op => op.entity === 'position:book')).toEqual([expect.objectContaining({ change: { type: 'position.put', key: 'book', value: restored } })]);
 expect(operations.find(op => op.entity === 'position:book')?.id).not.toBe(comparison.operationIds[0]);
 expect(await store.bookmarks.count()).toBe(1); expect(await store.sessions.count()).toBe(1);
 expect(vi.mocked(fetch).mock.calls.map(call => call[0])).toEqual(['/api/v1/auth/session']);
});
it('restores with no current place and does not create a fictional previous place', async () => {
 await restoreHistoricalPosition(store, await review(), content);
 expect((await store.positions.get('book'))?.offset).toBe(.3);
 expect(await store.positionHistory.count()).toBe(1);
 expect(await store.outbox.count()).toBe(1);
});
it('rejects late changes including identical recreation through another connection', async () => {
 const other = new LocalDatabase(store.name, store.scope);
 try {
  const absent = await review(); await savePosition(local, other);
  await expect(restoreHistoricalPosition(store, absent, content)).rejects.toThrow('изменилось');
  const comparison = await review();
  await savePosition({ ...local, offset: .8 }, other); await savePosition(local, other);
  await expect(restoreHistoricalPosition(store, comparison, content)).rejects.toThrow('изменилось');
  expect(await store.positions.get('book')).toEqual(local);
  expect(await store.positionHistory.count()).toBe(1);
 } finally { other.close(); }
});
it('rejects removed/changed historical entries and unavailable editions', async () => {
 const comparison = await review();
 await store.positionHistory.update('saved', { offset: .5 });
 await expect(restoreHistoricalPosition(store, comparison, content)).rejects.toThrow('История');
 await store.positionHistory.delete('saved');
 await expect(review()).rejects.toThrow('истории');
 await expect(restoreHistoricalPosition(store, comparison, content)).rejects.toThrow('История');
 await store.positionHistory.put(historical);
 for (const change of [{ version: '2' }, { paragraph: 'missing' }, { chapter: 2 }, { offset: 1 }]) {
  await expect(restoreHistoricalPosition(store, { ...comparison, historical: { ...historical, ...change } }, content)).rejects.toThrow('изданию');
 }
 expect(await store.positions.count()).toBe(0);
});
it('blocks unresolved choices and sending operations before and after comparison', async () => {
 await savePosition(local, store); const comparison = await review();
 await store.outbox.toCollection().modify({ state: 'sending' });
 await expect(review()).rejects.toThrow('отправляется');
 await expect(restoreHistoricalPosition(store, comparison, content)).rejects.toThrow('отправляется');
 await store.outbox.clear();
 await rememberPositionChoice(store, { bookId: 'book', choice: positionChoice(local, undefined), conflict: true });
 await expect(review()).rejects.toThrow('незавершённое');
 await expect(restoreHistoricalPosition(store, comparison, content)).rejects.toThrow('незавершённое');
 expect(await store.positions.get('book')).toEqual(local);
});
it('keeps data on guest/other ownership, expired/changed/unavailable session', async () => {
 await savePosition(local, store); const comparison = await review(); const ops = await store.outbox.toArray();
 const guest = new LocalDatabase('unused-history-guest');
 await expect(reviewPositionRestore(store, 'other', 'saved')).rejects.toThrow('Аккаунт');
 await expect(restoreHistoricalPosition(guest, comparison, content)).rejects.toThrow('Аккаунт');
 for (const response of [new Response('{}', { status: 401 }), new Response(JSON.stringify({ user: { id: 'other' } })), new Response('{}', { status: 503 })]) {
  vi.stubGlobal('fetch', vi.fn(async () => response));
  await expect(restoreHistoricalPosition(store, comparison, content)).rejects.toThrow();
  expect(await store.positions.get('book')).toEqual(local);
  expect(await store.outbox.toArray()).toEqual(ops);
  expect(await store.positionHistory.count()).toBe(1);
 }
});
it('rolls back archive, current place, metadata and queue on failure', async () => {
 await savePosition(local, store); const comparison = await review();
 const ops = await store.outbox.toArray(); const metadata = await store.metadata.toArray();
 const fail = () => { throw new Error('Disk full'); };
 store.outbox.hook('creating', fail);
 try { await expect(restoreHistoricalPosition(store, comparison, content)).rejects.toThrow('Disk full'); }
 finally { store.outbox.hook('creating').unsubscribe(fail); }
 expect(await store.positions.get('book')).toEqual(local);
 expect(await store.outbox.toArray()).toEqual(ops);
 expect(await store.metadata.toArray()).toEqual(metadata);
 expect(await store.positionHistory.count()).toBe(1);
 await restoreHistoricalPosition(store, comparison, content);
});
it('coordinates with reading and position requests and requires Web Locks', async () => {
 const comparison = await review();
 await navigator.locks.request(readingLockName(store.scope, 'book'), async () => {
  await expect(restoreHistoricalPosition(store, comparison, content)).rejects.toThrow('закрой читалку');
 });
 await withPositionChoiceLock(store, 'book', async () => {
  await expect(restoreHistoricalPosition(store, comparison, content)).rejects.toThrow('другой вкладке');
 });
 vi.stubGlobal('navigator', {});
 await expect(restoreHistoricalPosition(store, comparison, content)).rejects.toThrow('HTTPS');
 expect(await store.positions.count()).toBe(0);
});
