import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db, LocalDatabase, savePosition, toggleBookmark, deleteBookmark, saveReadingSession, bookmarkId, type Position } from './db';
import { accountDatabase, prepareAccountBook, resumeLocalAccountBook, validReadingLocator } from './account-reading';
import { rememberPositionChoice, sendPositionChoice } from './position-choices';
import { positionChoice } from './positions';
import { rememberBookmarkChoice, sendBookmarkChoice, forgetBookmarkChoice } from './bookmark-choices';
import type { BookContent } from './books';
const a = accountDatabase('00000000-0000-4000-8000-000000000001');
const b = accountDatabase('00000000-0000-4000-8000-000000000002');
const content: BookContent = { id: 'book', version: '1', chapters: [{ id: 'c1', title: 'Chapter', paragraphs: [{ id: 'p1', text: 'First' }, { id: 'p2', text: 'Second' }] }] };
const position: Position = { bookId: 'book', version: '1', chapter: 0, paragraph: 'p1', offset: .3, updatedAt: '2026-11-13T00:00:00Z' };
const remote = { bookId: 'book', version: '1', chapter: 0, paragraph: 'p2', offset: .6, revision: 2 };
const serverBookmark = { ...remote, label: 'Server bookmark' };
beforeEach(async () => {
 const { locks } = await vi.importActual<{ locks: LockManager }>('node:worker_threads');
 const prefix = crypto.randomUUID();
 vi.stubGlobal('navigator', { locks: { request: (name: string, options: LockOptions, callback: LockGrantedCallback<unknown>) => locks.request(prefix + name, options, callback) } });
});
afterEach(async () => { vi.unstubAllGlobals(); for (const store of [a, b, db]) { await store.delete(); await store.open(); } });
it('separates late writes, bookmarks, minutes and outbox ownership for two accounts and guest', async () => {
 await savePosition(position, db);
 await savePosition({ ...position, offset: .5 }, b);
 // This captures account A, as a reader's asynchronous cleanup does. Opening B
 // does not redirect a late write to B or the shared guest tables.
 await savePosition({ ...position, offset: .8 }, a);
 await toggleBookmark(position, 'Private', a);
 await saveReadingSession({ id: 'session', bookId: 'book', day: '2026-11-13', seconds: 12 }, a);
 expect((await db.positions.get('book'))?.offset).toBe(.3);
 expect((await b.positions.get('book'))?.offset).toBe(.5);
 expect((await a.positions.get('book'))?.offset).toBe(.8);
 expect(await db.bookmarks.count()).toBe(0); expect(await b.bookmarks.count()).toBe(0);
 expect(await db.sessions.count()).toBe(0); expect(await b.sessions.count()).toBe(0);
 expect((await a.outbox.toArray()).every(op => op.scope === a.scope)).toBe(true);
 a.close(); await a.open(); expect(await a.bookmarks.count()).toBe(1);
});
it('opens server state in the account database without guest copies or queued echo', async () => {
 await prepareAccountBook(a, content, remote, [serverBookmark], true, undefined);
 expect(await a.positions.get('book')).toMatchObject(remoteWithoutRevision());
 expect((await a.bookmarks.get(bookmarkId(serverBookmark)))?.label).toBe('Server bookmark');
 expect(await a.outbox.count()).toBe(0); expect(await db.positions.count()).toBe(0); expect(await db.bookmarks.count()).toBe(0);
});
function remoteWithoutRevision() { const { revision: _, ...locator } = remote; return locator; }
it('archives an explicitly replaced local place and keeps unrelated pending operations', async () => {
 await savePosition(position, a); await saveReadingSession({ id: 's', bookId: 'book', day: '2026-11-13', seconds: 3 }, a);
 await prepareAccountBook(a, content, remote, [], true, position);
 expect((await a.positionHistory.toArray())[0]).toMatchObject(position);
 expect((await a.positions.get('book'))?.paragraph).toBe('p2');
 expect((await a.outbox.toArray()).map(op => op.change.type)).toEqual(['session.put']);
});
it('keeps the local choice and protects pending bookmark deletes and edits from server snapshots', async () => {
 await savePosition(position, a);
 await prepareAccountBook(a, content, remote, [serverBookmark], false, position);
 expect(await a.positions.get('book')).toEqual(position);
 await deleteBookmark(bookmarkId(serverBookmark), a);
 await toggleBookmark(position, 'Private new bookmark', a);
 await prepareAccountBook(a, content, remote, [serverBookmark], false, position);
 expect(await a.bookmarks.get(bookmarkId(serverBookmark))).toBeUndefined();
 expect((await a.bookmarks.get(bookmarkId(position)))?.label).toBe('Private new bookmark');
});
it('removes untouched server bookmarks omitted from a fresh full snapshot', async () => {
 await prepareAccountBook(a, content, remote, [serverBookmark], false, undefined);
 await prepareAccountBook(a, content, remote, [], false, undefined);
 expect(await a.bookmarks.count()).toBe(0);
});
it('refuses stale choices and invalid editions without modifying data', async () => {
 await savePosition(position, a); const changed = { ...position, offset: .7 }; await savePosition(changed, a);
 await expect(prepareAccountBook(a, content, remote, [], true, position)).rejects.toThrow('другой вкладке');
 await expect(prepareAccountBook(a, content, { ...remote, version: 'old' }, [], true, changed)).rejects.toThrow('другому изданию');
 expect(await a.positions.get('book')).toEqual(changed); expect(await a.positionHistory.count()).toBe(0);
 expect(validReadingLocator({ ...remote, paragraph: 'missing' }, content)).toBe(false);
 await expect(prepareAccountBook(db, content, remote, [], true, undefined)).rejects.toThrow('отдельное хранилище');
});
it('rolls back a server choice, history and pending removal when a bookmark write fails', async () => {
 await savePosition(position, a); const queued = await a.outbox.toArray();
 const fail = () => { throw new Error('Storage full'); }; a.bookmarks.hook('creating', fail);
 try { await expect(prepareAccountBook(a, content, remote, [serverBookmark], true, position)).rejects.toThrow('Storage full'); }
 finally { a.bookmarks.hook('creating').unsubscribe(fail); }
 expect(await a.positions.get('book')).toEqual(position);
 expect(await a.positionHistory.count()).toBe(0); expect(await a.outbox.toArray()).toEqual(queued);
});

it('rejects malformed account identifiers before opening a namespace', () => {
 expect(() => accountDatabase('------------------------------------')).toThrow('определить аккаунт');
 expect(() => accountDatabase('000000000000400080000000000000000001')).toThrow('определить аккаунт');
});

it('keeps an interrupted save intact across reopen until the exact choice is confirmed', async () => {
 const session = { user: { id: a.scope.slice('account:'.length), email: 'a@example.test' }, csrfToken: 'csrf' };
 await savePosition(position, a);
 await toggleBookmark(position, 'Local bookmark', a);
 await saveReadingSession({ id: 'session', bookId: 'book', day: '2026-11-13', seconds: 12 }, a);
 const choice = positionChoice(position, remote);
 await rememberPositionChoice(a, { bookId: 'book', choice, remote, conflict: false });
 vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Lost response')));
 await expect(sendPositionChoice(a, session, 'book', choice.operationId)).rejects.toThrow('Не удалось связаться с сервисом');
 a.close(); await a.open();
 const before = { choice: await a.positionChoices.get('book'), outbox: await a.outbox.toArray(), bookmarks: await a.bookmarks.toArray() };
 await expect(prepareAccountBook(a, content, remote, [serverBookmark], true, position)).rejects.toThrow('незавершённое сохранение');
 expect(await a.positions.get('book')).toEqual(position);
 expect(await a.positionHistory.count()).toBe(0);
 expect(await a.positionChoices.get('book')).toEqual(before.choice);
 expect(await a.outbox.toArray()).toEqual(before.outbox);
 expect(await a.bookmarks.toArray()).toEqual(before.bookmarks);
 // Confirmation, including a receipt replay after a lost response, releases
 // the guard. The newly fetched server place can then be explicitly adopted.
 const confirmed = { ...position, revision: 3 };
 vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ accountId: session.user.id, position: confirmed }))));
 await sendPositionChoice(a, session, 'book', choice.operationId);
 await prepareAccountBook(a, content, confirmed, [serverBookmark], true, position);
 expect(await a.positionChoices.count()).toBe(0);
 expect((await a.outbox.toArray()).map(op => op.change.type).sort()).toEqual(['bookmark.put', 'session.put']);
});

it.each([false, true])('checks a choice created by another tab after loading (conflict=%s) and still allows local reading', async conflict => {
 await savePosition(position, a);
 const loadedLocal = await a.positions.get('book');
 const otherTab = new LocalDatabase(a.name, a.scope);
 const saved = { bookId: 'book', choice: positionChoice(position, remote), remote, conflict };
 try {
  await rememberPositionChoice(otherTab, saved);
  const before = await a.positionChoices.get('book');
  const outbox = await a.outbox.toArray();
  await expect(prepareAccountBook(a, content, remote, [serverBookmark], true, loadedLocal)).rejects.toThrow('незавершённое сохранение');
  await prepareAccountBook(a, content, remote, [serverBookmark], false, loadedLocal);
  expect(await a.positions.get('book')).toEqual(position);
  expect(await a.positionChoices.get('book')).toEqual(before);
  expect(await a.outbox.toArray()).toEqual(outbox);
  expect((await a.bookmarks.get(bookmarkId(serverBookmark)))?.label).toBe('Server bookmark');
 } finally { otherTab.close(); }
});

it('allows reading from the beginning while a guest-derived choice is unfinished', async () => {
 await rememberPositionChoice(a, { bookId: 'book', choice: positionChoice(position, remote), remote, conflict: false });
 await expect(prepareAccountBook(a, content, remote, [], true, undefined)).rejects.toThrow('незавершённое сохранение');
 await prepareAccountBook(a, content, remote, [], false, undefined);
 expect(await a.positions.count()).toBe(0);
 expect(await a.positionChoices.count()).toBe(1);
 expect(await a.outbox.count()).toBe(0);
});

it('does not block a server place because of another book or another account', async () => {
 await rememberPositionChoice(a, { bookId: 'other', choice: positionChoice({ ...position, bookId: 'other' }), conflict: false });
 await rememberPositionChoice(b, { bookId: 'book', choice: positionChoice(position), conflict: true });
 await prepareAccountBook(a, content, remote, [], true, undefined);
 expect((await a.positions.get('book'))?.paragraph).toBe(remote.paragraph);
 expect(await a.positionChoices.count()).toBe(1);
 expect(await b.positionChoices.count()).toBe(1);
 expect(await db.positions.count()).toBe(0);
});

it.each([false, true])('resumes only local account data without reconciling an unavailable snapshot (conflict=%s)', async conflict => {
 await savePosition(position, a);
 await toggleBookmark(position, 'Local bookmark', a);
 await prepareAccountBook(a, content, remote, [serverBookmark], false, position);
 await deleteBookmark(bookmarkId(serverBookmark), a);
 await saveReadingSession({ id: 'local-session', bookId: 'book', day: '2026-11-13', seconds: 12 }, a);
 await rememberPositionChoice(a, { bookId: 'book', choice: positionChoice(position, remote), remote, conflict });
 a.close(); await a.open();
 const before = await Promise.all(a.tables.map(table => table.toArray()));
 const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ user: { id: a.scope.slice(8), email: 'a@example.test' }, csrfToken: 'csrf' })));
 vi.stubGlobal('fetch', fetcher);
 await resumeLocalAccountBook(a, content);
 expect(fetcher).toHaveBeenCalledTimes(1);
 expect(fetcher.mock.calls[0][0]).toBe('/api/v1/auth/session');
 expect(await Promise.all(a.tables.map(table => table.toArray()))).toEqual(before);
 expect(await db.positions.count()).toBe(0);
 expect(await b.positions.count()).toBe(0);
});

it.each(['expired', 'changed', 'unavailable'] as const)('refuses local account recovery when the live session is %s', async failure => {
 await savePosition(position, a);
 const before = await a.outbox.toArray();
 const fetcher = vi.fn();
 if (failure === 'unavailable') fetcher.mockRejectedValue(new TypeError('Network unavailable'));
 else if (failure === 'expired') fetcher.mockResolvedValue(new Response('{}', { status: 401 }));
 else fetcher.mockResolvedValue(new Response(JSON.stringify({ user: { id: b.scope.slice(8) }, csrfToken: 'csrf' })));
 vi.stubGlobal('fetch', fetcher);
 await expect(resumeLocalAccountBook(a, content)).rejects.toThrow(failure === 'expired' ? 'Вход истёк' : failure === 'changed' ? 'Аккаунт изменился' : 'Не удалось связаться с сервисом');
 expect(await a.positions.get('book')).toEqual(position);
 expect(await a.outbox.toArray()).toEqual(before);
});

it('does not recover guest data or substitute another book, edition or invalid locator', async () => {
 const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ user: { id: a.scope.slice(8) }, csrfToken: 'csrf' })));
 vi.stubGlobal('fetch', fetcher);
 await expect(resumeLocalAccountBook(db, content)).rejects.toThrow('отдельное хранилище');
 expect(fetcher).not.toHaveBeenCalled();
 await savePosition(position, db);
 await savePosition(position, b);
 await savePosition({ ...position, bookId: 'other' }, a);
 await expect(resumeLocalAccountBook(a, content)).rejects.toThrow('нет места');
 for (const invalid of [{ ...position, version: 'old' }, { ...position, paragraph: 'missing' }, { ...position, chapter: 9 }, { ...position, offset: 1 }]) {
  await savePosition(invalid, a);
  await expect(resumeLocalAccountBook(a, content)).rejects.toThrow('нет места');
  expect(await a.positions.get('book')).toEqual(invalid);
 }
});


it.each([false, true])('preserves an unresolved bookmark across snapshots and reopen without outbox (conflict=%s)', async conflict => {
 const id = bookmarkId(serverBookmark);
 const local = { ...serverBookmark, id, label: 'Reviewed local label', offset: .2, updatedAt: 'before' };
 await a.bookmarks.put(local); // A previously received bookmark has no outbox.
 const change = { operationId: crypto.randomUUID(), expectedRevision: 2, bookmark: local, deleted: false };
 await rememberBookmarkChoice(a, change);
 if (conflict) await a.bookmarkChoices.update(id, { conflict: true });
 const saved = await a.bookmarkChoices.get(id);
 a.close(); await a.open();
 for (const snapshot of [[serverBookmark], []]) {
  await prepareAccountBook(a, content, remote, snapshot, false, undefined);
  expect(await a.bookmarks.get(id)).toEqual(local);
  expect(await a.bookmarkChoices.get(id)).toEqual(saved);
  expect(await a.outbox.count()).toBe(0);
 }
 // Cancelling the retry allows the next complete snapshot to reconcile again.
 await forgetBookmarkChoice(a, id, change.operationId);
 await prepareAccountBook(a, content, remote, [], false, undefined);
 expect(await a.bookmarks.get(id)).toBeUndefined();
});

it('does not resurrect a missing bookmark while its deletion awaits a receipt in another tab', async () => {
 const id = bookmarkId(serverBookmark);
 const change = { operationId: crypto.randomUUID(), expectedRevision: 2, bookmark: serverBookmark, deleted: true };
 const otherTab = new LocalDatabase(a.name, a.scope);
 const session = { user: { id: a.scope.slice(8), email: 'a@example.test' }, csrfToken: 'csrf' };
 try {
  await rememberBookmarkChoice(otherTab, change);
  const saved = await a.bookmarkChoices.get(id);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Lost response')));
  await expect(sendBookmarkChoice(otherTab, session, id, change.operationId)).rejects.toThrow('Не удалось связаться с сервисом');
  await prepareAccountBook(a, content, remote, [serverBookmark, { ...serverBookmark, paragraph: 'p1' }], false, undefined);
  expect(await a.bookmarks.get(id)).toBeUndefined();
  expect(await a.bookmarks.count()).toBe(1); // Unrelated bookmarks still load.
  expect(await a.bookmarkChoices.get(id)).toEqual(saved);
  expect(await a.outbox.count()).toBe(0);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ accountId: session.user.id, bookmark: { ...serverBookmark, deleted: true, revision: 3 } }))));
  await sendBookmarkChoice(otherTab, session, id, change.operationId);
  expect(await a.bookmarkChoices.get(id)).toBeUndefined();
  // A later fresh snapshot is authoritative after confirmation.
  await prepareAccountBook(a, content, remote, [serverBookmark], false, undefined);
  expect((await a.bookmarks.get(id))?.label).toBe(serverBookmark.label);
 } finally { otherTab.close(); }
});

it('does not protect a bookmark because another account has an unfinished choice for the same key', async () => {
 await rememberBookmarkChoice(b, { operationId: crypto.randomUUID(), expectedRevision: 2, bookmark: serverBookmark, deleted: true });
 await prepareAccountBook(a, content, remote, [serverBookmark], false, undefined);
 expect(await a.bookmarks.count()).toBe(1);
 expect(await b.bookmarkChoices.count()).toBe(1);
 expect(await db.bookmarks.count()).toBe(0);
});
