import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { LocalDatabase, saveReadingSession } from './db';
import { getSession, requestCode, verifyCode, type AccountSession } from './auth';
import { requestJSON } from './api';
import { readingSessionReport, sendReadingSessions } from './reading-session-sync';
import { loadReadingSessionHistory } from './reading-session-history';
import { startReadingTimeAuto, type ReadingTimeAutoState } from './reading-time-auto';

// Opt-in only: reading_journey.py owns these loopback ports and deletes its DB.
// This exercises real HTTP/API/SMTP/PostgreSQL, not React or browser storage.
it.skipIf(import.meta.env.VITE_LUMYBOO_LIVE_TEST !== '1')('saves time across two senders and A → B → A against the disposable API', async () => {
 const origin = 'http://127.0.0.1:4311';
 const realFetch = globalThis.fetch;
 const { locks } = await vi.importActual<{ locks: LockManager }>('node:worker_threads');
 const prefix = crypto.randomUUID();
 const stores: LocalDatabase[] = [];
 const senders: ReturnType<typeof startReadingTimeAuto>[] = [];
 const resendAt = new Map<string, number>();
 let cookie = '';
 let holdReply = false;
 let release!: () => void;
 const gate = new Promise<void>(resolve => { release = resolve; });
 let posts = 0;
 vi.stubGlobal('navigator', { locks: { request: (name: string, options: LockOptions, callback: LockGrantedCallback<unknown>) => locks.request(prefix + name, options, callback) } });
 vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
  if (!url.startsWith('/api/v1/')) throw new Error('Only the disposable API is allowed');
  const headers = new Headers(init.headers);
  headers.set('Origin', origin);
  if (cookie) headers.set('Cookie', cookie);
  const response = await realFetch(origin + url, { ...init, headers });
  const received = response.headers.get('set-cookie');
  if (received) cookie = received.split(';')[0];
  if (url === '/api/v1/reading-sessions/apply') {
   posts++;
   if (holdReply) { holdReply = false; await gate; }
  }
  return response;
 });
 const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
 async function login(email: string) {
  await delay(Math.max(0, (resendAt.get(email) ?? 0) - Date.now()));
  const challenge = await requestCode(email);
  resendAt.set(email, Date.now() + challenge.resendAfter * 1000 + 100);
  let code: string | undefined;
  await vi.waitFor(async () => {
   const response = await realFetch(`http://127.0.0.1:8025/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
   expect(response.ok).toBe(true);
   const mailbox = await response.json() as { messages: Array<{ Snippet: string }> };
   code = mailbox.messages[0]?.Snippet.match(/\b\d{6}\b/)?.[0];
   expect(code).toBeDefined();
  }, { timeout: 5000 });
  return verifyCode(challenge.challengeId, code!);
 }
 function storeFor(id: string) {
  const store = new LocalDatabase(`live-time-${crypto.randomUUID()}`, `account:${id}`);
  stores.push(store); return store;
 }
 function start(store: LocalDatabase) {
  const states: ReadingTimeAutoState[] = [];
  const sender = startReadingTimeAuto({
   accountId: store.scope.slice('account:'.length), online: () => true,
   hasWork: async () => (await store.outbox.toArray()).some(op => op.scope === store.scope && !!readingSessionReport(op)),
   verify: getSession, send: (session, signal) => sendReadingSessions(store, session, signal),
   publish: state => states.push(state),
  });
  senders.push(sender); return { sender, states };
 }
 async function logout(session: AccountSession) {
  await requestJSON('/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': session.csrfToken } });
 }
 const row = { id: crypto.randomUUID(), bookId: 'room-for-stories', version: '1', day: '2026-11-14', seconds: 12.345 };
 try {
  const email = `live-time-a-${prefix}@example.test`;
  const a = await login(email);
  const store = storeFor(a.user.id);
  const other = new LocalDatabase(store.name, store.scope); stores.push(other);
  await saveReadingSession(row, store);
  holdReply = true;
  const first = start(store);
  await vi.waitFor(() => expect(posts).toBe(1));
  const second = start(other);
  await vi.waitFor(() => expect(second.states.at(-1)?.message).toContain('другой вкладке'));
  release();
  await vi.waitFor(async () => expect(await store.outbox.count()).toBe(0));
  await vi.waitFor(() => expect(second.states.at(-1)?.message).toContain('автоматически'), { timeout: 6500 });
  expect(posts).toBe(1);
  expect([...first.states, ...second.states].some(state => state.message.includes('Не удалось'))).toBe(false);
  expect((await loadReadingSessionHistory(a.user.id)).items.map(item => item.milliseconds)).toEqual([12345]);
  first.sender.stop(); second.sender.stop();

  // Leave a newer local snapshot for A, then ensure a B cookie cannot send it.
  await saveReadingSession({ ...row, seconds: 20 }, store);
  await logout(a);
  const b = await login(`live-time-b-${prefix}@example.test`);
  const stale = start(store);
  await vi.waitFor(() => expect(stale.states.at(-1)?.phase).toBe('paused'));
  expect(posts).toBe(1);
  expect(await store.outbox.count()).toBe(1);
  expect((await loadReadingSessionHistory(b.user.id)).items).toEqual([]);
  const bStore = storeFor(b.user.id);
  await saveReadingSession({ ...row, id: crypto.randomUUID(), seconds: 4 }, bStore);
  const bSender = start(bStore);
  await vi.waitFor(async () => expect(await bStore.outbox.count()).toBe(0));
  expect((await loadReadingSessionHistory(b.user.id)).items.map(item => item.milliseconds)).toEqual([4000]);
  bSender.sender.stop(); stale.sender.stop();
  await logout(b);

  const again = await login(email); // Respect the real OTP resend interval.
  expect(again.user.id).toBe(a.user.id);
  const resumed = start(store);
  await vi.waitFor(async () => expect(await store.outbox.count()).toBe(0));
  expect(resumed.states.some(state => state.phase === 'paused' || state.message.includes('Не удалось'))).toBe(false);
  expect((await loadReadingSessionHistory(a.user.id)).items.map(item => item.milliseconds)).toEqual([20000]);
  expect((await store.sessions.get(row.id))?.seconds).toBe(20);
  expect(posts).toBe(3);
 } finally {
  release(); senders.forEach(sender => sender.stop());
  // Close both connections before deleting their shared database.
  stores.forEach(store => store.close());
  for (const store of new Map(stores.map(store => [store.name, store])).values()) await store.delete();
  vi.unstubAllGlobals();
 }
}, 95_000);
