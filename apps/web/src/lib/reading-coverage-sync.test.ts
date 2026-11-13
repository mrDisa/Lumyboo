import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LocalDatabase, savePosition } from './db';
import { coverageMillionths, queueStoredReadingCoverage, saveReadingCoverage, type ParagraphCoverage } from './reading-coverage';
import { readingCoverageReport, sendReadingCoverage } from './reading-coverage-sync';
import { accountSaveStatus } from './account-save-status';

const owner = '00000000-0000-4000-8000-000000000001';
const session = { user: { id: owner, email: 'a@example.test' }, csrfToken: 'old-csrf' };
const store = new LocalDatabase('coverage-sync', `account:${owner}`);
const content = { id: 'book', version: '1', chapters: [{ id: 'ch', title: 'Chapter', paragraphs: [{ id: 'p', text: 'Text' }, { id: 'q', text: 'More' }] }] };
const observe = (from = 0, to = .2, paragraph = 'p') => saveReadingCoverage(content, [{ paragraph, range: [from, to] }], store);
const body = (init?: RequestInit) => JSON.parse(String(init?.body));
const receipt = (init?: RequestInit) => { const p = body(init); return new Response(JSON.stringify({ accountId: p.accountId, coverage: p.coverage })); };
const legacy = (paragraph = 'p'): ParagraphCoverage => ({ bookId: 'book', version: '1', chapter: 'ch', paragraph, ranges: [[0, .2], [.8, 1]] });
function deferred() {
 let resolve!: () => void;
 const promise = new Promise<void>(done => { resolve = done; });
 return { promise, resolve };
}
beforeEach(async () => {
 const { locks } = await vi.importActual<{ locks: LockManager }>('node:worker_threads');
 const prefix = crypto.randomUUID();
 vi.stubGlobal('navigator', { locks: { request: (name: string, options: LockOptions, cb: LockGrantedCallback<unknown>) => locks.request(prefix + name, options, cb) } });
 vi.stubGlobal('fetch', vi.fn(async (url, init) => url === '/api/v1/auth/session' ? new Response(JSON.stringify({ ...session, csrfToken: 'fresh-csrf' })) : receipt(init)));
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await store.delete(); await store.open(); });

it('quantizes inward, handles binary multiplication noise and preserves sub-millionth gaps', () => {
 expect(coverageMillionths([[.000249, .000251], [.1000001, .2000009], [.2000011, .3]])).toEqual([[249, 251], [100001, 200000], [200002, 300000]]);
 expect(coverageMillionths([[.0000001, .0000009]])).toEqual([]);
 expect(() => coverageMillionths([[-1, 1]])).toThrow();
});
it('atomically queues changed account coverage without duplicates or guest changes', async () => {
 const guest = new LocalDatabase('coverage-guest');
 try {
  await observe(); const first = (await store.outbox.toArray())[0];
  expect(readingCoverageReport(first)).toEqual({ bookId: 'book', version: '1', paragraph: 'p', ranges: [[0, 200000]] });
  await observe(.05, .1); expect((await store.outbox.toArray())[0]).toEqual(first);
  await observe(.8, 1); expect(await store.outbox.count()).toBe(1);
  expect(readingCoverageReport((await store.outbox.toArray())[0])?.ranges).toEqual([[0, 200000], [800000, 1000000]]);
  expect((await accountSaveStatus(store)).coverage).toBe(1);
  await saveReadingCoverage(content, [{ paragraph: 'p', range: [0, 1] }], guest);
  expect(await guest.outbox.count()).toBe(0);
  expect((await guest.coverage.toArray())[0].queued).toBeUndefined();
  await expect(queueStoredReadingCoverage(guest)).rejects.toThrow('войти');
 } finally { await guest.delete(); }
});
it('rolls back coverage, queue and metadata if operation persistence fails', async () => {
 const add = vi.spyOn(store.outbox, 'add').mockRejectedValueOnce(new Error('Disk full'));
 await expect(observe()).rejects.toThrow('Disk full'); add.mockRestore();
 expect(await store.coverage.count()).toBe(0); expect(await store.metadata.count()).toBe(0); expect(await store.outbox.count()).toBe(0);
 await observe();
 await expect(saveReadingCoverage(content, [{ paragraph: 'q', range: [0, 1] }, { paragraph: 'p', range: [-1, 1] }], store)).rejects.toThrow();
 expect(await store.coverage.count()).toBe(1); expect(await store.outbox.count()).toBe(1);
});
it('queues legacy exact-edition observations once and preserves the marker across reopen', async () => {
 await store.coverage.put(legacy()); await queueStoredReadingCoverage(store);
 const first = await store.outbox.toArray(); expect(first).toHaveLength(1);
 store.close(); await store.open(); await queueStoredReadingCoverage(store);
 expect(await store.outbox.toArray()).toEqual(first);
 await sendReadingCoverage(store, session); await queueStoredReadingCoverage(store);
 expect(await store.outbox.count()).toBe(0); expect((await store.coverage.toArray())[0].version).toBe('1');
});
it('does not mark legacy observations queued when their outbox transaction fails', async () => {
 await store.coverage.put(legacy());
 const add = vi.spyOn(store.outbox, 'add').mockRejectedValueOnce(new Error('Disk full'));
 await expect(queueStoredReadingCoverage(store)).rejects.toThrow('Disk full'); add.mockRestore();
 expect((await store.coverage.toArray())[0].queued).toBeUndefined();
 expect(await store.outbox.count()).toBe(0); expect(await store.metadata.count()).toBe(0);
 await queueStoredReadingCoverage(store); expect(await store.outbox.count()).toBe(1);
});
it('does not send foreign or malformed operations and preserves their contents', async () => {
 await observe(); const original = (await store.outbox.toArray())[0];
 await store.outbox.update(original.id, { scope: 'account:other' });
 expect(await sendReadingCoverage(store, session)).toBe(0);
 await store.outbox.update(original.id, { scope: store.scope, entity: 'coverage:wrong' });
 const malformed = (await store.outbox.toArray())[0];
 expect(readingCoverageReport(malformed)).toBeUndefined();
 expect(await sendReadingCoverage(store, session)).toBe(0);
 expect((await store.outbox.toArray())[0]).toEqual(malformed);
 expect(vi.mocked(fetch).mock.calls.every(([url]) => url === '/api/v1/auth/session')).toBe(true);
});
it('splits large snapshots without dropping gaps and compacts only pending chunks', async () => {
 await saveReadingCoverage(content, Array.from({ length: 130 }, (_, i) => ({ paragraph: 'p', range: [i * 4 / 1e6, (i * 4 + 1) / 1e6] as [number, number] })), store);
 const ops = await store.outbox.orderBy('sequence').toArray();
 expect(ops.map(op => readingCoverageReport(op)?.ranges.length)).toEqual([64, 64, 2]);
 await store.outbox.update(ops[0].id, { state: 'sending' });
 await observe(0, .001);
 const next = await store.outbox.toArray(); expect(next).toHaveLength(2);
 expect(next.find(op => op.id === ops[0].id)).toEqual({ ...ops[0], state: 'sending' });
 expect(readingCoverageReport(next.find(op => op.state === 'pending')!)?.ranges).toEqual([[0, 1000]]);
});
it('sends with a live owner/CSRF and acknowledges only the sent snapshot', async () => {
 await observe();
 await savePosition({ bookId: 'book', version: '1', chapter: 0, paragraph: 'p', offset: 0, updatedAt: 'now' }, store);
 vi.mocked(fetch).mockImplementation(async (url, init) => {
  if (url === '/api/v1/auth/session') return new Response(JSON.stringify({ ...session, csrfToken: 'fresh-csrf' }));
  expect(url).toBe('/api/v1/reading-coverage/apply');
  expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('fresh-csrf');
  await observe(.8, 1); return receipt(init);
 });
 expect(await sendReadingCoverage(store, session)).toBe(1);
 const pending = await store.outbox.toArray(); expect(pending).toHaveLength(2);
 expect(pending.filter(op => op.change.type === 'coverage.put')).toHaveLength(1);
 expect((await store.coverage.toArray())[0].ranges).toEqual([[0, .2], [.8, 1]]);
});
it('retries the exact UUID and wire payload after loss of response and reopen', async () => {
 await observe(); let original = '';
 vi.mocked(fetch).mockImplementationOnce(async () => new Response(JSON.stringify(session))).mockImplementationOnce(async (_url, init) => { original = String(init?.body); throw new TypeError('Lost response'); });
 await expect(sendReadingCoverage(store, session)).rejects.toThrow('Lost response');
 await observe(.8, 1); store.close(); await store.open();
 let retry = '';
 vi.mocked(fetch).mockImplementation(async (url, init) => {
  if (url === '/api/v1/auth/session') return new Response(JSON.stringify(session));
  if (!retry) retry = String(init?.body);
  return receipt(init);
 });
 expect(await sendReadingCoverage(store, session)).toBe(2); expect(retry).toBe(original);
 expect(await store.outbox.count()).toBe(0);
 expect((await store.coverage.toArray())[0].ranges).toEqual([[0, .2], [.8, 1]]);
});
it('retains the immutable request when local acknowledgement fails', async () => {
 await observe(); const remove = vi.spyOn(store.outbox, 'delete').mockRejectedValueOnce(new Error('Ack failed'));
 await expect(sendReadingCoverage(store, session)).rejects.toThrow('Ack failed'); remove.mockRestore();
 const previous = (await store.outbox.toArray())[0]; expect(previous.state).toBe('sending');
 await sendReadingCoverage(store, session);
 const posts = vi.mocked(fetch).mock.calls.filter(([url]) => url === '/api/v1/reading-coverage/apply');
 expect(String(posts[0][1]?.body)).toBe(String(posts[1][1]?.body)); expect(await store.outbox.count()).toBe(0);
});
it('rejects wrong owners, identities, noncanonical or incomplete receipts without overwriting local coverage', async () => {
 await observe();
 for (const change of [{ accountId: 'other' }, { coverage: { ...legacy(), ranges: [[0, 200000]], version: 'old' } }, { coverage: { ...legacy(), ranges: [[0, 100000], [150000, 200000]] } }, { coverage: { ...legacy(), ranges: [[0, 100000], [100000, 200000]] } }, { coverage: { ...legacy(), ranges: [[0, 200000.1]] } }, { coverage: null }]) {
  vi.mocked(fetch).mockImplementation(async (url, init) => url === '/api/v1/auth/session' ? new Response(JSON.stringify(session)) : new Response(JSON.stringify({ accountId: owner, coverage: body(init).coverage, ...change })));
  await expect(sendReadingCoverage(store, session)).rejects.toThrow('не подтвердил');
  expect(await store.outbox.count()).toBe(1); expect((await store.coverage.toArray())[0].ranges).toEqual([[0, .2]]);
 }
});
it('blocks changed ownership and cancellation before preparing legacy data or POST', async () => {
 await store.coverage.put(legacy());
 await expect(sendReadingCoverage(store, { ...session, user: { ...session.user, id: 'other' } })).rejects.toThrow('Аккаунт');
 vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ...session, user: { ...session.user, id: 'other' } })));
 await expect(sendReadingCoverage(store, session)).rejects.toThrow('Аккаунт');
 expect(await store.outbox.count()).toBe(0);
 const controller = new AbortController(); controller.abort();
 await expect(sendReadingCoverage(store, session, controller.signal)).rejects.toThrow();
 expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
});
it('limits each batch to fifty operations and leaves other accounts untouched', async () => {
 await store.coverage.bulkPut(Array.from({ length: 51 }, (_, i) => legacy(`p-${i}`)));
 expect(await sendReadingCoverage(store, session)).toBe(50);
 expect(await store.outbox.count()).toBe(1);
 expect(await sendReadingCoverage(store, session)).toBe(1);
 expect(await store.coverage.count()).toBe(51);
 const other = new LocalDatabase('coverage-other', 'account:other');
 try { await other.coverage.put(legacy()); expect((await other.coverage.toArray())[0].queued).toBeUndefined(); } finally { await other.delete(); }
});
it('keeps the cross-tab lock until acknowledgement and preserves uncertain data on abort', async () => {
 await observe(); const started = deferred(); const finish = deferred();
 vi.mocked(fetch).mockImplementation(async (url, init) => {
  if (url === '/api/v1/auth/session') return new Response(JSON.stringify(session));
  started.resolve(); await finish.promise; return receipt(init);
 });
 const controller = new AbortController();
 const pending = expect(sendReadingCoverage(store, session, controller.signal)).rejects.toThrow();
 await started.promise;
 await expect(sendReadingCoverage(store, session)).rejects.toThrow('другой вкладке');
 controller.abort(); finish.resolve(); await pending;
 expect((await store.outbox.toArray())[0].state).toBe('sending');
});

it('automatically retries an uncertain snapshot on restart while preserving later observations and other queues', async () => {
 const { startReadingCoverageAuto, hasReadingCoverageWork } = await import('./reading-coverage-auto');
 const { getSession } = await import('./auth');
 const states: string[] = []; const requests: string[] = [];
 await observe();
 await savePosition({ bookId: 'book', version: '1', chapter: 0, paragraph: 'p', offset: 0, updatedAt: 'now' }, store);
 vi.mocked(fetch).mockImplementation(async (url, init) => {
  if (url === '/api/v1/auth/session') return new Response(JSON.stringify({ ...session, csrfToken: 'fresh-csrf' }));
  expect(url).toBe('/api/v1/reading-coverage/apply');
  requests.push(String(init?.body));
  if (requests.length === 1) return new Response(JSON.stringify({ message: 'Lost reply', code: 'unavailable' }), { status: 503 });
  return receipt(init);
 });
 const start = () => startReadingCoverageAuto({ accountId: owner, online: () => true, hasWork: () => hasReadingCoverageWork(store), verify: getSession, send: (live, signal) => sendReadingCoverage(store, live, signal), publish: state => states.push(state.message) });
 let sender = start();
 try {
  await vi.waitFor(() => expect(states.some(message => message.includes('повторим отправку позже'))).toBe(true));
  sender.stop();
  expect((await store.outbox.toArray()).find(op => op.change.type === 'coverage.put')?.state).toBe('sending');
  await observe(.8, 1);
  store.close(); await store.open();
  states.length = 0; sender = start();
  await vi.waitFor(() => expect(requests).toHaveLength(3));
  await vi.waitFor(() => expect(states.some(message => message.includes('сохраняются автоматически'))).toBe(true));
  expect(requests[1]).toBe(requests[0]);
  expect(body({ body: requests[2] }).coverage.ranges).toEqual([[0, 200000], [800000, 1000000]]);
  expect((await store.outbox.toArray()).map(op => op.change.type)).toEqual(['position.put']);
  expect((await store.coverage.toArray())[0].ranges).toEqual([[0, .2], [.8, 1]]);
 } finally { sender.stop(); }
});

it('finds legacy account work but excludes guests, foreign and malformed operations', async () => {
 const { hasReadingCoverageWork } = await import('./reading-coverage-auto');
 const guest = new LocalDatabase('coverage-auto-guest');
 try {
  await guest.coverage.put(legacy());
  expect(await hasReadingCoverageWork(guest)).toBe(false);
  expect(await hasReadingCoverageWork(store)).toBe(false);
  await observe(); const op = (await store.outbox.toArray())[0];
  await store.outbox.update(op.id, { scope: 'account:other' });
  expect(await hasReadingCoverageWork(store)).toBe(false);
  await store.outbox.update(op.id, { scope: store.scope, entity: 'broken' });
  expect(await hasReadingCoverageWork(store)).toBe(false);
  await store.coverage.put(legacy('q'));
  expect(await hasReadingCoverageWork(store)).toBe(true);
  await queueStoredReadingCoverage(store);
  expect(await hasReadingCoverageWork(store)).toBe(true);
 } finally { await guest.delete(); }
});
