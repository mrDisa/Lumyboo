import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });
it('treats Pages as guest-only without attempting account verification', async () => {
 vi.stubEnv('VITE_STATIC_HOST', 'true'); vi.resetModules(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
 const { getSession } = await import('./auth'); expect(await getSession()).toBeNull(); expect(fetch).not.toHaveBeenCalled();
});
it('never sends account payloads to static hosting', async () => {
 vi.stubEnv('VITE_STATIC_HOST', 'true'); vi.resetModules(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
 const { requestJSON, listBooks } = await import('./api');
 await expect(requestJSON('/auth/code', { method: 'POST', body: '{"email":"reader@example.test"}' })).rejects.toMatchObject({ code: 'preview_only' });
 await expect(listBooks()).rejects.toThrow('демоверсии'); expect(fetch).not.toHaveBeenCalled();
});
