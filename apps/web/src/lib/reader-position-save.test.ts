import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LocalDatabase, savePosition } from './db';
import { createReaderPositionSave } from './reader-position-save';
import type { BookContent } from './books';
const accountId = '00000000-0000-4000-8000-000000000001';
const store = new LocalDatabase('reader-position-save-tests', `account:${accountId}`);
const session = { user: { id: accountId, email: 'a@example.test' }, csrfToken: 'csrf' };
const local = { bookId: 'book', version: '1', chapter: 0, paragraph: 'p1', offset: .6, updatedAt: 'today' };
const remote = { ...local, offset: .2, revision: 4 };
const content = { id: 'book', version: '1', chapters: [{ paragraphs: [{ id: 'p1', text: 'Text' }] }] } as BookContent;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
beforeEach(async () => {
 const { locks } = await vi.importActual<{ locks: LockManager }>('node:worker_threads');
 const prefix = crypto.randomUUID();
 vi.stubGlobal('navigator', { locks: { request: (name: string, options: LockOptions, cb: LockGrantedCallback<unknown>) => locks.request(prefix + name, options, cb) } });
 await savePosition(local, store);
});
afterEach(async () => { vi.unstubAllGlobals(); await store.delete(); await store.open(); });
it('saves against the opening revision and clears only the confirmed position', async () => {
 const fetcher = vi.fn(async (url: string, _options?: RequestInit) => url.endsWith('/auth/session') ? json(session) : json({ accountId, position: { ...local, revision: 5 } }));
 vi.stubGlobal('fetch', fetcher);
 await createReaderPositionSave(store, content, remote)();
 const payload = JSON.parse(fetcher.mock.calls[1][1]!.body as string);
 expect(payload).toMatchObject({ accountId, expectedRevision: 4, position: { bookId: 'book', offset: .6 } });
 expect(await store.outbox.count()).toBe(0);
 expect(await store.positionChoices.count()).toBe(0);
});
it('retries the identical persisted operation after a lost response and reopen', async () => {
 const bodies: string[] = [];
 vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
  if (url.endsWith('/auth/session')) return json(session);
  bodies.push(options!.body as string);
  if (bodies.length === 1) throw new TypeError('Lost response');
  return json({ accountId, position: { ...local, revision: 5 } });
 }));
 const save = createReaderPositionSave(store, content, remote);
 await expect(save()).rejects.toThrow('Lost response');
 expect(await store.positionChoices.count()).toBe(1);
 store.close(); await store.open();
 await save();
 expect(bodies).toHaveLength(2);
 expect(bodies[1]).toBe(bodies[0]);
 expect(await store.outbox.count()).toBe(0);
 expect(await store.positionChoices.count()).toBe(0);
});
it('persists a revision conflict and never fetches a newer revision to overwrite it', async () => {
 const fetcher = vi.fn(async (url: string) => url.endsWith('/auth/session') ? json(session) : json({ error: { code: 'position_conflict', message: 'Compare again' } }, 409));
 vi.stubGlobal('fetch', fetcher);
 const save = createReaderPositionSave(store, content, remote);
 await expect(save()).rejects.toMatchObject({ code: 'position_conflict' });
 expect((await store.positionChoices.get('book'))?.conflict).toBe(true);
 await expect(save()).rejects.toThrow();
 expect(fetcher.mock.calls.filter(([url]) => !url.endsWith('/auth/session'))).toHaveLength(1);
 expect(await store.outbox.count()).toBe(1);
 expect((await store.positions.get('book'))?.offset).toBe(.6);
});
it('keeps an older unresolved choice and does not automatically send it', async () => {
 const saved = { bookId: 'book', conflict: false, choice: { operationId: 'old', expectedRevision: 1, position: local } };
 await store.positionChoices.put(saved);
 const fetcher = vi.fn(async () => json(session)); vi.stubGlobal('fetch', fetcher);
 await expect(createReaderPositionSave(store, content, remote)()).rejects.toThrow('незавершённое');
 expect(fetcher).toHaveBeenCalledOnce();
 expect(await store.positionChoices.get('book')).toEqual(saved);
});
it('refuses expired sessions, switched owners and guest stores before sending', async () => {
 const fetcher = vi.fn().mockResolvedValueOnce(json({ error: { code: 'unauthorized', message: 'Expired' } }, 401)).mockResolvedValueOnce(json({ ...session, user: { ...session.user, id: 'other' } })).mockResolvedValueOnce(json(session));
 vi.stubGlobal('fetch', fetcher);
 const save = createReaderPositionSave(store, content, remote);
 await expect(save()).rejects.toThrow('Вход истёк');
 await expect(save()).rejects.toThrow('Аккаунт изменился');
 const guest = new LocalDatabase('reader-save-guest');
 try { await expect(createReaderPositionSave(guest, content)()).rejects.toThrow('Аккаунт изменился'); }
 finally { await guest.delete(); }
 expect(fetcher).toHaveBeenCalledTimes(3);
 expect(await store.positionChoices.count()).toBe(0);
 expect(await store.outbox.count()).toBe(1);
});
it('uses revision zero only when the opening snapshot had no server position', async () => {
 const fetcher = vi.fn(async (url: string, _options?: RequestInit) => url.endsWith('/auth/session') ? json(session) : json({ accountId, position: { ...local, revision: 1 } }));
 vi.stubGlobal('fetch', fetcher);
 await createReaderPositionSave(store, content)();
 expect(JSON.parse(fetcher.mock.calls[1][1]!.body as string).expectedRevision).toBe(0);
});
it('does not send if the local choice cannot be persisted', async () => {
 const fetcher = vi.fn(async () => json(session)); vi.stubGlobal('fetch', fetcher);
 const fail = () => { throw new Error('Storage full'); }; store.positionChoices.hook('creating', fail);
 try { await expect(createReaderPositionSave(store, content, remote)()).rejects.toThrow('Storage full'); }
 finally { store.positionChoices.hook('creating').unsubscribe(fail); }
 expect(fetcher).toHaveBeenCalledOnce();
 expect(await store.outbox.count()).toBe(1);
});
