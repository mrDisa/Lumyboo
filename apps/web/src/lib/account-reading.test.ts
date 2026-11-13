import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { db, LocalDatabase, savePosition, toggleBookmark, deleteBookmark, saveReadingSession, bookmarkId, type Position } from './db';
import { accountDatabase, prepareAccountBook, validReadingLocator } from './account-reading';
import { rememberPositionChoice, sendPositionChoice } from './position-choices';
import { positionChoice } from './positions';
import type { BookContent } from './books';
const a = accountDatabase('00000000-0000-4000-8000-000000000001');
const b = accountDatabase('00000000-0000-4000-8000-000000000002');
const content: BookContent = { id: 'book', version: '1', chapters: [{ id: 'c1', title: 'Chapter', paragraphs: [{ id: 'p1', text: 'First' }, { id: 'p2', text: 'Second' }] }] };
const position: Position = { bookId: 'book', version: '1', chapter: 0, paragraph: 'p1', offset: .3, updatedAt: '2026-11-13T00:00:00Z' };
const remote = { bookId: 'book', version: '1', chapter: 0, paragraph: 'p2', offset: .6, revision: 2 };
const serverBookmark = { ...remote, label: 'Server bookmark' };
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
 await expect(sendPositionChoice(a, session, 'book', choice.operationId)).rejects.toThrow('Lost response');
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
