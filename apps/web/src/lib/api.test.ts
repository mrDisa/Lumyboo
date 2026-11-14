import { afterEach, expect, it, vi } from 'vitest';
import { requestJSON } from './api';
import { startReadingTimeAuto } from './reading-time-auto';
import { getSession } from './auth';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function unavailable(retryAfter: string) {
 return new Response('{}', { status: 503, headers: { 'Retry-After': retryAfter } });
}
it.each(['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.'])('explains a transport failure (%s) without signing out', async (message) => {
 const original = new TypeError(message);
 vi.stubGlobal('fetch', vi.fn().mockRejectedValue(original));
 await expect(getSession()).rejects.toMatchObject({
  name: 'TypeError', message: 'Не удалось связаться с сервисом. Проверь подключение и попробуй ещё раз.', cause: original,
 });
});
it('keeps automatic saving retryable after a translated network failure', async () => {
 vi.useFakeTimers();
 const fetch = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(new Response('{}'));
 vi.stubGlobal('fetch', fetch);
 const session = { user: { id: 'a', email: 'a@example.test' }, csrfToken: 'csrf' };
 const sender = startReadingTimeAuto({ accountId: 'a', online: () => true, hasWork: async () => true, verify: async () => session, send: async () => { await requestJSON('/reading-sessions/apply'); return 1; }, publish: () => {} });
 try {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(4999); expect(fetch).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1); expect(fetch).toHaveBeenCalledTimes(2);
 } finally { sender.stop(); }
});
it('explains a broken successful response body as an uncertain transport failure', async () => {
 vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => { throw new TypeError('Failed to fetch'); } }));
 await expect(requestJSON('/positions/choose')).rejects.toMatchObject({ name: 'TypeError', message: expect.stringContaining('Проверь подключение') });
});
it('does not sign out when the connection breaks while reading a 401 body', async () => {
 vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => { throw new TypeError('Load failed'); } }));
 await expect(getSession()).rejects.toMatchObject({ name: 'TypeError', message: expect.stringContaining('Проверь подключение') });
});
it('retains the HTTP failure when an error body is not JSON', async () => {
 vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>Unavailable</html>', { status: 503 })));
 await expect(requestJSON('/auth/session')).rejects.toMatchObject({ status: 503, code: 'unavailable' });
});
it('honors an HTTP-date Retry-After through the automatic sender', async () => {
 vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-13T12:00:00.250Z'));
 const fetch = vi.fn().mockResolvedValueOnce(unavailable('Fri, 13 Nov 2026 12:01:00 GMT')).mockResolvedValueOnce(new Response('{}'));
 vi.stubGlobal('fetch', fetch);
 const session = { user: { id: 'a', email: 'a@example.test' }, csrfToken: 'csrf' };
 const sender = startReadingTimeAuto({ accountId: 'a', online: () => true, hasWork: async () => true, verify: async () => session, send: async () => { await requestJSON('/reading-sessions/apply'); return 1; }, publish: () => {} });
 try {
  await vi.advanceTimersByTimeAsync(0);
  sender.wake();
  await vi.advanceTimersByTimeAsync(59_999); expect(fetch).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1); expect(fetch).toHaveBeenCalledTimes(2);
 } finally { sender.stop(); }
});
it.each([
 ['60', 60], ['0', 0], ['-1', 0], ['1.5', 0], ['1e3', 0], ['Infinity', 0], ['tomorrow', 0],
 ['Thu, 12 Nov 2026 12:00:00 GMT', 0], ['Fri, 13 Nov 2026 12:01:00 GMT', 60],
 ['Friday, 13-Nov-26 12:01:00 GMT', 60], ['Fri Nov 13 12:01:00 2026', 60],
])('parses Retry-After %s as %s seconds', async (header, expected) => {
 vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-13T12:00:00.250Z'));
 vi.stubGlobal('fetch', vi.fn().mockResolvedValue(unavailable(header)));
 await expect(requestJSON('/reading-sessions/apply')).rejects.toMatchObject({ status: 503, retryAfter: expected });
 expect(vi.getTimerCount()).toBe(0);
});
it('cancels a pending response body and clears its timeout', async () => {
 vi.useFakeTimers();
 const controller = new AbortController();
 vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => ({ ok: true, status: 200, json: () => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))) })));
 const request = requestJSON('/reading-sessions/apply', { signal: controller.signal });
 const checked = expect(request).rejects.toMatchObject({ name: 'AbortError' });
 await vi.advanceTimersByTimeAsync(0); controller.abort(); await checked;
 expect(vi.getTimerCount()).toBe(0);
});
it('preserves a timeout while reading an error body instead of reporting an authentication failure', async () => {
 vi.useFakeTimers();
 vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => ({ ok: false, status: 401, headers: new Headers(), json: () => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))) })));
 const checked = expect(requestJSON('/auth/session')).rejects.toMatchObject({ name: 'TimeoutError', message: 'Сервис не ответил вовремя. Попробуй ещё раз.' });
 await vi.advanceTimersByTimeAsync(12_000); await checked;
 expect(vi.getTimerCount()).toBe(0);
});
