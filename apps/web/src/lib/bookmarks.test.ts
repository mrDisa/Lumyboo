import { afterEach, expect, it, vi } from 'vitest';
import { bookmarkEntry, importGuestBookmarks, loadAccountBookmarks } from './bookmarks';
const session = { user: { id: 'account-a', email: 'a@example.test' }, csrfToken: 'csrf-a' };
const entry = { bookId: 'book', version: '1', chapter: 0, paragraph: 'p1', offset: .4, label: 'Chapter' };
afterEach(() => vi.unstubAllGlobals());
it('copies reviewed locators without guest IDs or timestamps', async () => {
 const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ accountId: 'account-a', bookmarks: [entry] })));
 vi.stubGlobal('fetch', fetcher);
 const copy = bookmarkEntry({ ...entry, id: 'guest-id', updatedAt: 'guest-clock' });
 await importGuestBookmarks(session, [copy]);
 const [url, init] = fetcher.mock.calls[0];
 expect(url).toBe('/api/v1/bookmarks/import');
 expect(JSON.parse(init.body)).toEqual({ accountId: 'account-a', bookmarks: [entry] });
 expect(init.headers.get('X-CSRF-Token')).toBe('csrf-a');
 expect(init.cache).toBe('no-store');
});
it('rejects bookmarks returned for a switched account', async () => {
 vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify({ accountId: 'account-b', bookmarks: [entry] }))));
 await expect(loadAccountBookmarks('account-a')).rejects.toMatchObject({ code: 'account_changed' });
 await expect(importGuestBookmarks(session, [entry])).rejects.toMatchObject({ code: 'account_changed' });
});
