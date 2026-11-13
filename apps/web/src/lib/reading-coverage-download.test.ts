import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LocalDatabase } from './db';
import type { BookContent } from './books';
import { saveReadingCoverage } from './reading-coverage';
import { receiveReadingCoverage } from './reading-coverage-download';
import { sendReadingCoverage } from './reading-coverage-sync';

const owner = '00000000-0000-4000-8000-000000000001';
const session = { user: { id: owner, email: 'a@example.test' }, csrfToken: 'csrf' };
const store = new LocalDatabase('coverage-download', `account:${owner}`);
const content: BookContent = { id: 'book', version: '1', chapters: [{ id: 'ch', title: 'Chapter', paragraphs: [{ id: 'p', text: 'One' }, { id: 'q', text: 'Two' }] }] };
const report = (paragraph = 'p', ranges = [[800000, 1000000]]) => ({ bookId: 'book', version: '1', paragraph, ranges });
const page = (items = [report()], nextCursor = '') => ({ accountId: owner, items, nextCursor });
const respond = (value: unknown) => new Response(JSON.stringify(value));
const local = (paragraph = 'p') => store.coverage.get(['book', '1', paragraph]);
beforeEach(async () => {
 const { locks } = await vi.importActual<{ locks: LockManager }>('node:worker_threads');
 const prefix = crypto.randomUUID();
 vi.stubGlobal('navigator', { locks: { request: (name: string, options: LockOptions, cb: LockGrantedCallback<unknown>) => locks.request(prefix + name, options, cb) } });
 vi.stubGlobal('fetch', vi.fn(async url => url === '/api/v1/auth/session' ? respond(session) : respond(page())));
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await store.delete(); await store.open(); });

it('unions server observations with local gaps without acknowledging pending or sending data', async () => {
 await saveReadingCoverage(content, [{ paragraph: 'p', range: [0, .2] }], store);
 const pending = (await store.outbox.toArray())[0];
 await store.outbox.update(pending.id, { state: 'sending' }); const before = await store.outbox.toArray();
 expect(await receiveReadingCoverage(store, session, content)).toBe(1);
 expect((await local())?.ranges).toEqual([[0, .2], [.8, 1]]);
 expect(await store.outbox.toArray()).toEqual(before);
 expect(await receiveReadingCoverage(store, session, content)).toBe(0);
 store.close(); await store.open(); expect((await local())?.ranges).toEqual([[0, .2], [.8, 1]]);
});
it('stores server-only observations with no outgoing echo and preserves unqueued legacy observations', async () => {
 expect(await receiveReadingCoverage(store, session, content)).toBe(1);
 expect(await local()).toMatchObject({ chapter: 'ch', queued: true, ranges: [[.8, 1]] });
 expect(await store.outbox.count()).toBe(0); expect(await store.metadata.count()).toBe(0);
 await store.coverage.put({ bookId: 'book', version: '1', chapter: 'ch', paragraph: 'p', ranges: [[0, .2]] });
 await receiveReadingCoverage(store, session, content);
 expect((await local())?.queued).toBeUndefined();
 expect((await local())?.ranges).toEqual([[0, .2], [.8, 1]]);
 expect(await store.outbox.count()).toBe(0);
});
it('preserves empty-history data and all other books, editions and namespaces', async () => {
 await saveReadingCoverage(content, [{ paragraph: 'p', range: [0, .2] }], store);
 await store.coverage.put({ bookId: 'book', version: 'old', chapter: 'ch', paragraph: 'p', ranges: [[0, 1]] });
 await store.coverage.put({ bookId: 'other', version: '1', chapter: 'ch', paragraph: 'p', ranges: [[0, 1]] });
 const before = await store.coverage.toArray(); const operations = await store.outbox.toArray();
 vi.mocked(fetch).mockImplementation(async url => url === '/api/v1/auth/session' ? respond(session) : respond(page([])));
 expect(await receiveReadingCoverage(store, session, content)).toBe(0);
 expect(await store.coverage.toArray()).toEqual(before); expect(await store.outbox.toArray()).toEqual(operations);
 const guest = new LocalDatabase('coverage-download-guest');
 try { await expect(receiveReadingCoverage(guest, session, content)).rejects.toThrow('Аккаунт'); expect(await guest.coverage.count()).toBe(0); } finally { await guest.delete(); }
});
it('keeps observations written while the server pages are in flight', async () => {
 vi.mocked(fetch).mockImplementation(async url => {
  if (url === '/api/v1/auth/session') return respond(session);
  await saveReadingCoverage(content, [{ paragraph: 'p', range: [0, .2] }], store);
  return respond(page());
 });
 await receiveReadingCoverage(store, session, content);
 expect((await local())?.ranges).toEqual([[0, .2], [.8, 1]]);
 expect(await store.outbox.count()).toBe(1);
});
it('rejects wrong owners, editions, locators, ordering and malformed ranges with no partial write', async () => {
 const badPages = [
  { ...page(), accountId: 'other' }, { ...page(), items: null }, { ...page(), nextCursor: null },
  page([report('q'), report('p')]), page([report(), report()]),
  page([report('unknown')]), page([{ ...report(), bookId: 'other' }]), page([{ ...report(), version: 'old' }]),
  page([report('p', [[0, 100000], [100000, 200000]])]), page([report('p', [[0, 100000.1]])]),
  page([report('p', [[0, 1000000, 1]])]), page([report('p', [[0, 1000001]])]),
  page([report('p', [])]), page([report('p', [[-1, 1]])]), page([report()], 'p'),
 ];
 for (const invalid of badPages) {
  vi.mocked(fetch).mockImplementation(async url => url === '/api/v1/auth/session' ? respond(session) : respond(invalid));
  await expect(receiveReadingCoverage(store, session, content)).rejects.toThrow();
  expect(await store.coverage.count()).toBe(0); expect(await store.outbox.count()).toBe(0);
 }
});
it('fetches all live pages before committing, using the exact version and cursor', async () => {
 const paragraphs = Array.from({ length: 51 }, (_, i) => ({ id: `p-${String(i).padStart(2, '0')}`, text: 'Text' }));
 const long = { ...content, chapters: [{ ...content.chapters[0], paragraphs }] };
 vi.mocked(fetch).mockImplementation(async url => {
  if (url === '/api/v1/auth/session') return respond(session);
  expect(String(url)).toContain('version=1&limit=50');
  const next = String(url).includes('cursor=p-49');
  expect(await store.coverage.count()).toBe(0);
  return respond(next ? page([report('p-50')]) : page(paragraphs.slice(0, 50).map(p => report(p.id)), 'p-49'));
 });
 expect(await receiveReadingCoverage(store, session, long)).toBe(51);
 expect(await store.coverage.count()).toBe(51); expect(await store.outbox.count()).toBe(0);
});
it('does not commit earlier pages after a later page error or repeated cursor', async () => {
 const paragraphs = Array.from({ length: 50 }, (_, i) => ({ id: `p-${String(i).padStart(2, '0')}`, text: 'Text' }));
 const long = { ...content, chapters: [{ ...content.chapters[0], paragraphs }] };
 for (const repeat of [false, true]) {
  vi.mocked(fetch).mockImplementation(async url => {
   if (url === '/api/v1/auth/session') return respond(session);
   if (String(url).includes('cursor=') && !repeat) throw new TypeError('Network lost');
   return respond(page(paragraphs.map(p => report(p.id)), 'p-49'));
  });
  await expect(receiveReadingCoverage(store, session, long)).rejects.toThrow();
  expect(await store.coverage.count()).toBe(0);
 }
});
it('rechecks the live owner after fetching all pages, including empty history', async () => {
 for (const items of [[], [report()]]) {
  let checks = 0;
  vi.mocked(fetch).mockImplementation(async url => url === '/api/v1/auth/session' ? respond(++checks === 1 ? session : { ...session, user: { ...session.user, id: 'other' } }) : respond(page(items)));
  await expect(receiveReadingCoverage(store, session, content)).rejects.toThrow('Аккаунт');
  expect(await store.coverage.count()).toBe(0);
 }
});
it('rolls back the entire import on a storage error or cancellation during commit', async () => {
 vi.mocked(fetch).mockImplementation(async url => url === '/api/v1/auth/session' ? respond(session) : respond(page([report('p'), report('q')])));
 const put = vi.spyOn(store.coverage, 'put');
 put.mockImplementationOnce(value => store.coverage.add(value)).mockRejectedValueOnce(new Error('Disk full'));
 await expect(receiveReadingCoverage(store, session, content)).rejects.toThrow('Disk full'); put.mockRestore();
 expect(await store.coverage.count()).toBe(0);
 const controller = new AbortController(); const fail = vi.spyOn(store.coverage, 'put');
 fail.mockImplementationOnce(value => store.coverage.add(value).then(key => { controller.abort(); return key; }));
 await expect(receiveReadingCoverage(store, session, content, controller.signal)).rejects.toThrow(); fail.mockRestore();
 expect(await store.coverage.count()).toBe(0);
});
it('serializes with sending across tabs and leaves no data after an aborted request', async () => {
 let release!: () => void; let started!: () => void;
 const gate = new Promise<void>(resolve => { release = resolve; }); const ready = new Promise<void>(resolve => { started = resolve; });
 vi.mocked(fetch).mockImplementation(async url => {
  if (url === '/api/v1/auth/session') return respond(session);
  started(); await gate; return respond(page());
 });
 const controller = new AbortController();
 const pending = expect(receiveReadingCoverage(store, session, content, controller.signal)).rejects.toThrow();
 await ready;
 await expect(sendReadingCoverage(store, session)).rejects.toThrow('другой вкладке');
 controller.abort(); release(); await pending; expect(await store.coverage.count()).toBe(0);
});
it('rejects locally inconsistent edition structure and handles bytewise Unicode ordering', async () => {
 await store.coverage.put({ bookId: 'book', version: '1', chapter: 'old-chapter', paragraph: 'p', ranges: [[0, .2]] });
 await expect(receiveReadingCoverage(store, session, content)).rejects.toThrow('Структура');
 expect((await local())?.ranges).toEqual([[0, .2]]);
 const ids = ['\uE000', '\u{10000}']; // UTF-16 comparison would invert these.
 const unicode = { ...content, chapters: [{ ...content.chapters[0], paragraphs: ids.map(id => ({ id, text: 'Text' })) }] };
 vi.mocked(fetch).mockImplementation(async url => url === '/api/v1/auth/session' ? respond(session) : respond(page(ids.map(id => report(id)))));
 expect(await receiveReadingCoverage(store, session, unicode)).toBe(2);
});
