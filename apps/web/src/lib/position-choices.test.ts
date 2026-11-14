import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LocalDatabase, savePosition, toggleBookmark, saveReadingSession, type SavedPositionChoice } from './db';
import { rememberPositionChoice, sendPositionChoice, forgetPositionChoice } from './position-choices';
const accountId = '00000000-0000-4000-8000-000000000001';
const store = new LocalDatabase('position-choice-tests', `account:${accountId}`);
const session = { user: { id: accountId, email: 'a@example.test' }, csrfToken: 'csrf' };
const position = { bookId: 'book', version: '1', chapter: 0, paragraph: 'p1', offset: .3 };
const choice: SavedPositionChoice = { bookId: 'book', conflict: false, choice: { operationId: 'operation-a', expectedRevision: 2, position }, remote: { ...position, offset: .1, revision: 2 } };
beforeEach(async () => {
 const { locks } = await vi.importActual<{ locks: LockManager }>('node:worker_threads');
 const prefix = crypto.randomUUID();
 vi.stubGlobal('navigator', { locks: { request: (name: string, options: LockOptions, callback: LockGrantedCallback<unknown>) => locks.request(prefix + name, options, callback) } });
});
afterEach(async () => { vi.unstubAllGlobals(); await store.delete(); await store.open(); });
it('reopens an uncertain choice and resends the identical payload without clearing newer reading', async () => {
 const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('Lost response')).mockResolvedValue(new Response(JSON.stringify({ accountId, position: { ...position, revision: 3 } })));
 vi.stubGlobal('fetch', fetcher);
 await rememberPositionChoice(store, choice);
 await expect(sendPositionChoice(store, session, 'book', 'operation-a')).rejects.toThrow('Не удалось связаться с сервисом');
 store.close(); await store.open();
 expect(await store.positionChoices.get('book')).toEqual(choice);
 await savePosition({ ...position, offset: .9, updatedAt: 'later' }, store);
 await sendPositionChoice(store, session, 'book', 'operation-a');
 expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body);
 expect(await store.positionChoices.count()).toBe(0);
 expect((await store.positions.get('book'))?.offset).toBe(.9);
 expect(await store.outbox.count()).toBe(1);
});
it('preserves conflicts across reload and requires a fresh explicit comparison', async () => {
 const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'position_conflict', message: 'Compare again' } }), { status: 409 }));
 vi.stubGlobal('fetch', fetcher);
 await rememberPositionChoice(store, choice);
 await expect(sendPositionChoice(store, session, 'book', 'operation-a')).rejects.toMatchObject({ code: 'position_conflict' });
 store.close(); await store.open();
 expect((await store.positionChoices.get('book'))?.conflict).toBe(true);
 await expect(sendPositionChoice(store, session, 'book', 'operation-a')).rejects.toThrow('Сравни');
 expect(fetcher).toHaveBeenCalledTimes(1);
});
it('rejects account switches, guest storage and replacement from a second tab before sending', async () => {
 const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
 await rememberPositionChoice(store, choice);
 await expect(sendPositionChoice(store, { ...session, user: { ...session.user, id: 'another' } }, 'book', 'operation-a')).rejects.toThrow('Аккаунт');
 await expect(rememberPositionChoice(new LocalDatabase('unused-guest'), choice)).rejects.toThrow('Аккаунт');
 await expect(rememberPositionChoice(store, { ...choice, choice: { ...choice.choice, operationId: 'operation-b' } })).rejects.toThrow('незавершённое');
 await forgetPositionChoice(store, 'book', 'operation-b');
 expect(await store.positionChoices.get('book')).toEqual(choice);
 expect(fetcher).not.toHaveBeenCalled();
});
it('retains the exact choice on session expiry or a response owned by another account', async () => {
 const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'Sign in' } }), { status: 401 })).mockResolvedValueOnce(new Response(JSON.stringify({ accountId: 'another', position })));
 vi.stubGlobal('fetch', fetcher);
 await rememberPositionChoice(store, choice);
 await expect(sendPositionChoice(store, session, 'book', 'operation-a')).rejects.toMatchObject({ status: 401 });
 await expect(sendPositionChoice(store, session, 'book', 'operation-a')).rejects.toMatchObject({ code: 'account_changed' });
 expect(await store.positionChoices.get('book')).toEqual(choice);
});
it('never sends a choice that failed to persist', async () => {
 const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
 const fail = () => { throw new Error('Storage full'); }; store.positionChoices.hook('creating', fail);
 try { await expect(rememberPositionChoice(store, choice)).rejects.toThrow('Storage full'); }
 finally { store.positionChoices.hook('creating').unsubscribe(fail); }
 await expect(sendPositionChoice(store, session, 'book', 'operation-a')).rejects.toThrow('изменился');
 expect(fetcher).not.toHaveBeenCalled();
});
it('upgrades v3 without losing reading data or queued changes', async () => {
 await store.delete();
 const old = new Dexie(store.name);
 old.version(3).stores({ settings: 'id', positions: 'bookId', bookmarks: 'id, bookId', shelf: 'bookId', downloads: 'bookId', sessions: 'id, day, bookId', positionHistory: 'id, bookId, [bookId+version]', outbox: 'id, sequence, [entity+state]', metadata: 'id' });
 await old.table('positions').put({ ...position, updatedAt: 'before' });
 await old.table('outbox').put({ id: 'existing', sequence: 1, entity: 'position:book', state: 'pending' });
 old.close(); await store.open();
 await rememberPositionChoice(store, choice);
 expect((await store.positions.get('book'))?.updatedAt).toBe('before');
 expect((await store.outbox.toArray()).map(op => op.id)).toEqual(['existing']);
 expect(await store.positionChoices.get('book')).toEqual(choice);
});
it('acknowledges only captured position operations and keeps unrelated data', async () => {
 await savePosition({ ...position, updatedAt: 'before' }, store);
 const [sent] = await store.outbox.toArray();
 await rememberPositionChoice(store, choice);
 expect((await store.positionChoices.get('book'))?.coveredPositionOperationIds).toEqual([sent.id]);
 await savePosition({ ...position, bookId: 'other', updatedAt: 'before' }, store);
 await toggleBookmark({ ...position, updatedAt: 'before' }, 'chapter', store);
 await saveReadingSession({ id: 'session', bookId: 'book', day: '2026-11-13', seconds: 20 }, store);
 // Reopen the database as after a page reload.
 store.close(); await store.open();
 vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ accountId, position: { ...position, revision: 3 } }))));
 await sendPositionChoice(store, session, 'book', 'operation-a');
 expect((await store.outbox.toArray()).map(op => op.change.type).sort()).toEqual(['bookmark.put', 'position.put', 'session.put']);
 expect(await store.outbox.get(sent.id)).toBeUndefined();
 expect(await store.positionChoices.count()).toBe(0);
 expect((await store.positions.get('book'))?.updatedAt).toBe('before');
});
it('preserves reading written while the request is in flight', async () => {
 await savePosition({ ...position, updatedAt: 'before' }, store);
 await rememberPositionChoice(store, choice);
 vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => {
  await savePosition({ ...position, offset: .7, updatedAt: 'during-request' }, store);
  return new Response(JSON.stringify({ accountId, position: { ...position, revision: 3 } }));
 }));
 await sendPositionChoice(store, session, 'book', 'operation-a');
 expect((await store.positions.get('book'))?.offset).toBe(.7);
 expect((await store.outbox.toArray()).map(op => op.change.type)).toEqual(['position.put']);
});
it('never widens the acknowledgement boundary on retry, even at the same locator', async () => {
 await savePosition({ ...position, updatedAt: 'before' }, store);
 await rememberPositionChoice(store, choice);
 const saved = await store.positionChoices.get('book');
 await savePosition({ ...position, updatedAt: 'later' }, store);
 const [later] = await store.outbox.toArray();
 await rememberPositionChoice(store, choice);
 expect(await store.positionChoices.get('book')).toEqual(saved);
 vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ accountId, position: { ...position, revision: 3 } }))));
 await sendPositionChoice(store, session, 'book', 'operation-a');
 expect((await store.outbox.toArray()).map(op => op.id)).toEqual([later.id]);
});
it('preserves covered operations on conflicts, incorrect receipts and cancellation', async () => {
 await savePosition({ ...position, updatedAt: 'before' }, store);
 await rememberPositionChoice(store, choice);
 vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ accountId, position: { ...position, offset: .8, revision: 3 } }))));
 await expect(sendPositionChoice(store, session, 'book', 'operation-a')).rejects.toThrow('не подтвердил');
 expect(await store.outbox.count()).toBe(1);
 expect(await store.positionChoices.count()).toBe(1);
 vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'position_conflict', message: 'Compare again' } }), { status: 409 })));
 await expect(sendPositionChoice(store, session, 'book', 'operation-a')).rejects.toMatchObject({ code: 'position_conflict' });
 expect(await store.outbox.count()).toBe(1);
 await forgetPositionChoice(store, 'book', 'operation-a');
 expect(await store.outbox.count()).toBe(1);
});
it('keeps old choices without an acknowledgement boundary and unrelated queued changes', async () => {
 await store.positionChoices.put(choice); // Persisted by the preceding app version.
 await savePosition({ ...position, updatedAt: 'before' }, store);
 vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ accountId, position: { ...position, revision: 3 } }))));
 await sendPositionChoice(store, session, 'book', 'operation-a');
 expect(await store.outbox.count()).toBe(1);
});
it('rolls back acknowledgement if the local receipt cannot be committed', async () => {
 await savePosition({ ...position, updatedAt: 'before' }, store);
 await rememberPositionChoice(store, choice);
 vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ accountId, position: { ...position, revision: 3 } }))));
 const fail = () => { throw new Error('Storage failure'); };
 store.positionChoices.hook('deleting', fail);
 try { await expect(sendPositionChoice(store, session, 'book', 'operation-a')).rejects.toThrow('Storage failure'); }
 finally { store.positionChoices.hook('deleting').unsubscribe(fail); }
 expect(await store.outbox.count()).toBe(1);
 expect(await store.positionChoices.count()).toBe(1);
 await sendPositionChoice(store, session, 'book', 'operation-a');
 expect(await store.outbox.count()).toBe(0);
 expect(await store.positionChoices.count()).toBe(0);
});

it('blocks cancellation, replacement and duplicate sends from another connection until the receipt is saved', async () => {
 const other = new LocalDatabase(store.name, store.scope);
 let finish!: (response: Response) => void;
 const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
 vi.stubGlobal('fetch', fetcher);
 await savePosition({ ...position, updatedAt: 'before' }, store);
 await rememberPositionChoice(store, choice);
 const sending = sendPositionChoice(store, session, 'book', 'operation-a');
 try {
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  await expect(forgetPositionChoice(other, 'book', 'operation-a')).rejects.toThrow('другой вкладке');
  await expect(sendPositionChoice(other, session, 'book', 'operation-a')).rejects.toThrow('другой вкладке');
  await expect(rememberPositionChoice(other, { ...choice, choice: { ...choice.choice, operationId: 'replacement' } })).rejects.toThrow('другой вкладке');
  expect((await other.positionChoices.get('book'))?.choice.operationId).toBe('operation-a');
  expect(await other.outbox.count()).toBe(1);
  expect(fetcher).toHaveBeenCalledOnce();
 } finally {
  finish(new Response(JSON.stringify({ accountId, position: { ...position, revision: 3 } })));
  await sending;
  other.close();
 }
 expect(await store.positionChoices.count()).toBe(0);
 expect(await store.outbox.count()).toBe(0);
 await rememberPositionChoice(store, choice); // The committed receipt releases ownership.
});

it('releases ownership after a lost response so an explicit cancellation remains possible', async () => {
 let fail!: (error: Error) => void;
 const fetcher = vi.fn(() => new Promise<Response>((_, reject) => { fail = reject; }));
 vi.stubGlobal('fetch', fetcher);
 await rememberPositionChoice(store, choice);
 const result = expect(sendPositionChoice(store, session, 'book', 'operation-a')).rejects.toThrow('Не удалось связаться с сервисом');
 await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
 await expect(forgetPositionChoice(store, 'book', 'operation-a')).rejects.toThrow('другой вкладке');
 fail(new TypeError('Lost response'));
 await result;
 expect(await store.positionChoices.get('book')).toEqual(choice);
 await forgetPositionChoice(store, 'book', 'operation-a');
 expect(await store.positionChoices.count()).toBe(0);
});

it('keeps other books and other accounts independent during a pending request', async () => {
 const otherAccount = new LocalDatabase('other-choice-account', 'account:other');
 let finish!: (response: Response) => void;
 const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
 vi.stubGlobal('fetch', fetcher);
 await rememberPositionChoice(store, choice);
 const sending = sendPositionChoice(store, session, 'book', 'operation-a');
 try {
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  const anotherBook = { ...choice, bookId: 'another-book', choice: { ...choice.choice, position: { ...position, bookId: 'another-book' } } };
  await rememberPositionChoice(store, anotherBook);
  await forgetPositionChoice(store, 'another-book', 'operation-a');
  await rememberPositionChoice(otherAccount, choice);
  await forgetPositionChoice(otherAccount, 'book', 'operation-a');
  expect(await otherAccount.positionChoices.count()).toBe(0);
  expect(await store.positionChoices.count()).toBe(1);
 } finally {
  finish(new Response(JSON.stringify({ accountId, position: { ...position, revision: 3 } })));
  await sending;
  await otherAccount.delete();
 }
});

it('preserves the choice and queue without sending when safe locking is unavailable', async () => {
 await savePosition({ ...position, updatedAt: 'before' }, store);
 await rememberPositionChoice(store, choice);
 const saved = await store.positionChoices.get('book');
 const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
 vi.stubGlobal('navigator', {});
 await expect(sendPositionChoice(store, session, 'book', 'operation-a')).rejects.toThrow('HTTPS');
 await expect(forgetPositionChoice(store, 'book', 'operation-a')).rejects.toThrow('HTTPS');
 await expect(rememberPositionChoice(store, choice)).rejects.toThrow('HTTPS');
 expect(await store.positionChoices.get('book')).toEqual(saved);
 expect(await store.outbox.count()).toBe(1);
 expect(fetcher).not.toHaveBeenCalled();
});

it('holds ownership after the server responds until the local receipt transaction commits', async () => {
 await savePosition({ ...position, updatedAt: 'before' }, store);
 await rememberPositionChoice(store, choice);
 vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ accountId, position: { ...position, revision: 3 } }))));
 let release!: () => void;
 const receipt = new Promise<void>(resolve => { release = resolve; });
 let committing = false;
 const hold = () => { committing = true; void Dexie.waitFor(receipt); };
 store.positionChoices.hook('deleting', hold);
 const sending = sendPositionChoice(store, session, 'book', 'operation-a');
 try {
  await vi.waitFor(() => expect(committing).toBe(true));
  await expect(forgetPositionChoice(store, 'book', 'operation-a')).rejects.toThrow('другой вкладке');
  await expect(sendPositionChoice(store, session, 'book', 'operation-a')).rejects.toThrow('другой вкладке');
 } finally {
  release();
  await sending;
  store.positionChoices.hook('deleting').unsubscribe(hold);
 }
 expect(await store.positionChoices.count()).toBe(0);
 expect(await store.outbox.count()).toBe(0);
 await rememberPositionChoice(store, choice);
});
