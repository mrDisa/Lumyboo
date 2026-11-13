import { afterEach, expect, it, vi } from 'vitest';
import { loadReadingSessionHistory, readingDuration } from './reading-session-history';
const accountId = 'account-a';
afterEach(() => vi.unstubAllGlobals());
it('loads an owner-checked live page with a bounded request and forwards cancellation', async () => {
 const cursor = '2026-11-13_00000000-0000-4000-8000-000000000001';
 const page = { accountId, items: [{ milliseconds: 60000 }], nextCursor: cursor };
 vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(page))));
 const controller = new AbortController();
 expect(await loadReadingSessionHistory(accountId, '', controller.signal)).toEqual(page);
 const [url, init] = vi.mocked(fetch).mock.calls[0];
 expect(url).toBe('/api/v1/reading-sessions/?limit=20');
 expect(init?.cache).toBe('no-store'); expect(init?.credentials).toBe('same-origin');
 expect(init?.signal).toBeInstanceOf(AbortSignal);
 await loadReadingSessionHistory(accountId, cursor);
 expect(vi.mocked(fetch).mock.calls[1][0]).toBe(`/api/v1/reading-sessions/?limit=20&cursor=${cursor}`);
});
it('rejects an account switch and surfaces auth/network errors without automatic retries', async () => {
 vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ accountId: 'other', items: [], nextCursor: '' }))));
 await expect(loadReadingSessionHistory(accountId)).rejects.toMatchObject({ code: 'account_changed' });
 for (const status of [401, 503]) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'unavailable', message: 'Недоступно' } }), { status })));
  await expect(loadReadingSessionHistory(accountId)).rejects.toThrow('Недоступно');
  expect(fetch).toHaveBeenCalledOnce();
 }
 vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Offline'); }));
 await expect(loadReadingSessionHistory(accountId)).rejects.toThrow('Offline');
});
it('displays partial minutes without rounding them up or truncating hours', () => {
 expect([1, 999, 1000, 59999, 60000, 119999, 3600000, 86400000].map(readingDuration)).toEqual(['меньше секунды', 'меньше секунды', '1 с', '59 с', '1 мин 0 с', '1 мин 59 с', '60 мин 0 с', '1440 мин 0 с']);
});

it('cancels a pending page request when the owner view unmounts', async () => {
 vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
  init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
 })));
 const controller = new AbortController();
 const pending = loadReadingSessionHistory(accountId, '', controller.signal);
 controller.abort();
 await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
 expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
});
