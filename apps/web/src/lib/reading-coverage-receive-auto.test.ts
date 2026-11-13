import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LocalDatabase } from './db';
import type { BookContent } from './books';
import { saveReadingCoverage } from './reading-coverage';
import { startReadingCoverageReceive } from './reading-coverage-receive-auto';

const realTimeout = globalThis.setTimeout;
const realDelay = (ms: number) => new Promise<void>(resolve => realTimeout(resolve, ms));
const owner = '00000000-0000-4000-8000-000000000001';
const session = { user: { id: owner, email: 'a@example.test' }, csrfToken: 'csrf' };
const store = new LocalDatabase('coverage-receive-auto', `account:${owner}`);
const content: BookContent = { id: 'book', version: '1', chapters: [{ id: 'ch', title: 'Chapter', paragraphs: [{ id: 'p', text: 'Text' }] }] };
const item = { bookId: 'book', version: '1', paragraph: 'p', ranges: [[800000, 1000000]] };
const response = (value: unknown) => new Response(JSON.stringify(value));
const page = (items = [item]) => response({ accountId: owner, items, nextCursor: '' });
const active: ReturnType<typeof startReadingCoverageReceive>[] = [];
function start(overrides: Partial<Parameters<typeof startReadingCoverageReceive>[0]> = {}) {
 const publish = vi.fn();
 const receiver = startReadingCoverageReceive({ store, session, content, online: () => true, publish, ...overrides });
 active.push(receiver); return { receiver, publish };
}
const requests = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('/reading-coverage/'));
beforeEach(async () => {
 vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
 const { locks } = await vi.importActual<{ locks: LockManager }>('node:worker_threads');
 const prefix = crypto.randomUUID();
 vi.stubGlobal('navigator', { locks: { request: (name: string, options: LockOptions, callback: LockGrantedCallback<unknown>) => locks.request(prefix + name, options, callback) } });
 vi.stubGlobal('fetch', vi.fn(async url => url === '/api/v1/auth/session' ? response(session) : page()));
});
// IndexedDB uses real asynchronous tasks, independently of the scheduler clock.
async function settle(check: () => boolean) {
 for (let i = 0; i < 100 && !check(); i++) await realDelay(10);
 expect(check()).toBe(true);
}
afterEach(async () => {
 active.splice(0).forEach(receiver => receiver.stop());
 vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await store.delete(); await store.open();
});
it('receives once per opening, merging late local observations without clearing their queue', async () => {
 vi.mocked(fetch).mockImplementation(async url => {
  if (url === '/api/v1/auth/session') return response(session);
  await saveReadingCoverage(content, [{ paragraph: 'p', range: [0, .2] }], store);
  return page();
 });
 const { receiver, publish } = start();
 await settle(() => publish.mock.calls.some(([state]) => state.phase === 'waiting'));
 expect((await store.coverage.get(['book', '1', 'p']))?.ranges).toEqual([[0, .2], [.8, 1]]);
 expect(await store.outbox.count()).toBe(1);
 receiver.wake(); receiver.resume(); await vi.advanceTimersByTimeAsync(600_000);
 expect(requests()).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
});
it('treats an empty history as successful and does not poll again', async () => {
 vi.mocked(fetch).mockImplementation(async url => url === '/api/v1/auth/session' ? response(session) : page([]));
 const { publish } = start(); await settle(() => publish.mock.calls.some(([state]) => state.phase === 'waiting'));
 await vi.advanceTimersByTimeAsync(60_000); expect(requests()).toHaveLength(1); expect(await store.coverage.count()).toBe(0);
});
it('waits for connectivity and backs off a failed request without online events bypassing the delay', async () => {
 let online = false; let calls = 0;
 vi.mocked(fetch).mockImplementation(async url => {
  if (url === '/api/v1/auth/session') return response(session);
  if (++calls === 1) return new Response('{}', { status: 503 });
  return page();
 });
 const { receiver, publish } = start({ online: () => online });
 expect(fetch).not.toHaveBeenCalled(); online = true; receiver.wake();
 await settle(() => publish.mock.calls.some(([state]) => state.message.includes('позже')));
 receiver.wake(); await vi.advanceTimersByTimeAsync(4999); expect(requests()).toHaveLength(1);
 await vi.advanceTimersByTimeAsync(1);
 await settle(() => publish.mock.calls.some(([state]) => state.message.includes('получены')));
 expect(requests()).toHaveLength(2);
});
it('retries lock contention instead of permanently pausing', async () => {
 const original = navigator.locks.request.bind(navigator.locks); let busy = true;
 vi.spyOn(navigator.locks, 'request').mockImplementation(((name: string, options: LockOptions, cb: LockGrantedCallback<unknown>) => busy ? Promise.resolve(cb(null)) : original(name, options, cb)) as typeof navigator.locks.request);
 const { publish } = start(); await settle(() => publish.mock.calls.some(([state]) => state.message.includes('позже')));
 busy = false; await vi.advanceTimersByTimeAsync(5000);
 await settle(() => publish.mock.calls.some(([state]) => state.message.includes('получены')));
 expect(requests()).toHaveLength(1);
});
it('pauses on an owner change before fetching or writing coverage', async () => {
 vi.mocked(fetch).mockResolvedValue(response({ ...session, user: { ...session.user, id: 'other' } }));
 const { receiver, publish } = start(); await settle(() => publish.mock.calls.some(([state]) => state.phase === 'paused'));
 receiver.wake(); await vi.advanceTimersByTimeAsync(600_000);
 expect(requests()).toHaveLength(0); expect(await store.coverage.count()).toBe(0);
});
it('stops retries on malformed data and leaves local observations intact', async () => {
 await saveReadingCoverage(content, [{ paragraph: 'p', range: [0, .2] }], store);
 const before = await store.coverage.toArray(); const queue = await store.outbox.toArray();
 vi.mocked(fetch).mockImplementation(async url => url === '/api/v1/auth/session' ? response(session) : page([{ ...item, version: 'old' }]));
 const { publish } = start(); await settle(() => publish.mock.calls.some(([state]) => state.phase === 'paused'));
 await vi.advanceTimersByTimeAsync(600_000); expect(requests()).toHaveLength(1);
 expect(await store.coverage.toArray()).toEqual(before); expect(await store.outbox.toArray()).toEqual(queue);
});
it('ignores a late response after leaving the reader', async () => {
 let finish!: (value: Response) => void;
 vi.mocked(fetch).mockImplementation(async url => url === '/api/v1/auth/session' ? response(session) : new Promise<Response>(resolve => { finish = resolve; }));
 const { receiver, publish } = start(); await settle(() => !!finish);
 receiver.stop(); const count = publish.mock.calls.length; finish(page());
 await vi.advanceTimersByTimeAsync(600_000);
 expect(await store.coverage.count()).toBe(0); expect(publish).toHaveBeenCalledTimes(count); expect(vi.getTimerCount()).toBe(0);
});
it('rejects guest and foreign databases before starting requests', async () => {
 const guest = new LocalDatabase('coverage-receive-auto-guest');
 try { expect(() => start({ store: guest })).toThrow('Аккаунт'); expect(fetch).not.toHaveBeenCalled(); }
 finally { await guest.delete(); }
});

it('does not mistake fifty changed paragraphs for an outgoing batch needing another fetch', async () => {
 const paragraphs = Array.from({ length: 50 }, (_, i) => ({ id: `p-${String(i).padStart(2, '0')}`, text: 'Text' }));
 const book = { ...content, chapters: [{ ...content.chapters[0], paragraphs }] };
 vi.mocked(fetch).mockImplementation(async url => url === '/api/v1/auth/session' ? response(session) : page(paragraphs.map(p => ({ ...item, paragraph: p.id }))));
 const { receiver, publish } = start({ content: book });
 await settle(() => publish.mock.calls.some(([state]) => state.message.includes('получены')));
 receiver.wake(); await vi.advanceTimersByTimeAsync(60_000);
 expect(requests()).toHaveLength(1); expect(await store.coverage.count()).toBe(50); expect(vi.getTimerCount()).toBe(0);
});
