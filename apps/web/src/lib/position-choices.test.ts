import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalDatabase, savePosition, type SavedPositionChoice } from './db';
import { rememberPositionChoice, sendPositionChoice, forgetPositionChoice } from './position-choices';
const accountId = '00000000-0000-4000-8000-000000000001';
const store = new LocalDatabase('position-choice-tests', `account:${accountId}`);
const session = { user: { id: accountId, email: 'a@example.test' }, csrfToken: 'csrf' };
const position = { bookId: 'book', version: '1', chapter: 0, paragraph: 'p1', offset: .3 };
const choice: SavedPositionChoice = { bookId: 'book', conflict: false, choice: { operationId: 'operation-a', expectedRevision: 2, position }, remote: { ...position, offset: .1, revision: 2 } };
afterEach(async () => { vi.unstubAllGlobals(); await store.delete(); await store.open(); });
it('reopens an uncertain choice and resends the identical payload without clearing newer reading', async () => {
 const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('Lost response')).mockResolvedValue(new Response(JSON.stringify({ accountId, position: { ...position, revision: 3 } })));
 vi.stubGlobal('fetch', fetcher);
 await rememberPositionChoice(store, choice);
 await expect(sendPositionChoice(store, session, 'book', 'operation-a')).rejects.toThrow('Lost response');
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
