import { afterEach, expect, it, vi } from 'vitest';
import { importGuestShelf, loadAccountShelf } from './shelf';
const session = { user: { id: 'account-a', email: 'a@example.test' }, csrfToken: 'csrf-a' };
afterEach(() => vi.unstubAllGlobals());
it('imports only the reviewed books with an explicit account assertion and CSRF', async () => {
 const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ accountId: 'account-a', bookIds: ['existing', 'new'] })));
 vi.stubGlobal('fetch', fetcher);
 expect((await importGuestShelf(session, ['new'])).bookIds).toEqual(['existing', 'new']);
 const [url, init] = fetcher.mock.calls[0];
 expect(url).toBe('/api/v1/shelf/import');
 expect(JSON.parse(init.body)).toEqual({ accountId: 'account-a', bookIds: ['new'] });
 expect(init.headers.get('X-CSRF-Token')).toBe('csrf-a');
 expect(init.cache).toBe('no-store');
});
it('rejects a response for an account changed in another tab', async () => {
 vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ accountId: 'account-b', bookIds: ['private'] }))));
 await expect(loadAccountShelf('account-a')).rejects.toMatchObject({ code: 'account_changed' });
 await expect(importGuestShelf(session, ['new'])).rejects.toMatchObject({ code: 'account_changed' });
});
it('reports an uncertain import as retryable without changing local guest data', async () => {
 vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Network error')));
 await expect(importGuestShelf(session, ['new'])).rejects.toThrow('Network error');
});
