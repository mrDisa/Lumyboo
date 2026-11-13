import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { verifiedResponse, downloadBook, loadBook, reconcileDownloads, BOOK_CACHE, type Book } from './books';
import { db } from './db';
const content = { id: 'test', version: '1', chapters: [{ id: 'ch-1', title: 'Глава', paragraphs: [{ id: 'ch-1-p-1', text: 'Тихий вечер.' }] }] };
async function fixture(value: unknown = content) {
  const raw = JSON.stringify(value);
  const bytes = new TextEncoder().encode(raw);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  return { raw, book: { id: 'test', version: '1', sha256: hash, bytes: bytes.byteLength, url: '/books/test.json' } as Book };
}
function mockCache() {
  const entries = new Map<string, Response>();
  const cache = {
    match: vi.fn(async (key: string) => entries.get(key)?.clone()),
    put: vi.fn(async (key: string, response: Response) => { entries.set(key, response.clone()); }),
    delete: vi.fn(async (key: string) => entries.delete(key)),
  };
  const open = vi.fn(async () => cache);
  vi.stubGlobal('caches', { open });
  return { entries, cache, open };
}
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await db.downloads.clear(); });
it('rejects corrupt, truncated and substituted content', async () => {
  const { raw, book } = await fixture();
  await expect(verifiedResponse(book, new Response(raw.replace('вечер', 'ветер')))).rejects.toThrow('проверку');
  await expect(verifiedResponse(book, new Response(raw.slice(0, -1)))).rejects.toThrow('не полностью');
  await expect(verifiedResponse(book, new Response(raw + ' '))).rejects.toThrow('Размер');
  await expect(verifiedResponse({ ...book, version: '2' }, new Response(raw))).rejects.toThrow('формат');
});
it('validates chapter and paragraph locators even when the digest matches', async () => {
  for (const value of [{ ...content, chapters: [{ id: 'ch-1' }] }, { ...content, chapters: [{ ...content.chapters[0], paragraphs: [{ id: 'ch-1', text: 'duplicate id' }] }] }]) {
    const { raw, book } = await fixture(value);
    await expect(verifiedResponse(book, new Response(raw))).rejects.toThrow('формат');
  }
});
it('reports completion only after integrity verification', async () => {
  const { raw, book } = await fixture(); const progress = vi.fn();
  const response = await verifiedResponse(book, new Response(raw), progress);
  expect(await response.json()).toEqual(content);
  expect(progress.mock.calls.at(-1)).toEqual([100]);
  progress.mockClear();
  await expect(verifiedResponse({ ...book, sha256: 'invalid' }, new Response(raw), progress)).rejects.toThrow();
  expect(progress.mock.calls.some(([n]) => n === 100)).toBe(false);
});
it('loads a downloaded book after a complete client restart without network', async () => {
  const { raw, book } = await fixture(); const { open } = mockCache();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(raw)));
  await downloadBook(book); db.close(); await db.open();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
  expect(await loadBook(book)).toEqual(content);
  expect(fetch).not.toHaveBeenCalled();
  expect(open).toHaveBeenCalledWith(BOOK_CACHE);
  expect(await db.downloads.get(book.id)).toMatchObject({ hash: book.sha256 });
});
it('keeps an earlier verified download when a retry is interrupted', async () => {
  const { raw, book } = await fixture(); const { entries } = mockCache();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(raw))); await downloadBook(book);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('connection lost')));
  await expect(downloadBook(book)).rejects.toThrow('connection lost');
  expect(entries.has(book.url)).toBe(true);
  expect(await db.downloads.get(book.id)).toBeDefined();
});
it('removes stale download badges when the browser evicts or corrupts a cached book', async () => {
  const { raw, book } = await fixture(); const { entries } = mockCache();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(raw))); await downloadBook(book);
  entries.set(book.url, new Response('broken'));
  await reconcileDownloads([book]); expect(await db.downloads.get(book.id)).toBeUndefined();
  await db.downloads.put({ bookId: book.id, version: '1', bytes: book.bytes, hash: book.sha256 });
  await reconcileDownloads([book]); expect(await db.downloads.get(book.id)).toBeUndefined();
});
