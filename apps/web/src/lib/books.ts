import { db } from './db';
import type { components } from './api.generated';
export type Book = components['schemas']['Book'];
export interface Chapter { id: string; title: string; paragraphs: { id: string; text: string }[] }
export interface BookContent { id: string; version: string; chapters: Chapter[] }
export const BOOK_CACHE = 'lumyboo-books-v1';
const secureBookMessage = 'Для чтения и загрузки книг открой Lumyboo по HTTPS. Адрес HTTP в локальной сети подходит только для просмотра интерфейса.';
function requireBookStorage() {
 if (typeof caches === 'undefined' || !crypto.subtle) throw new Error(secureBookMessage);
}


function isBookContent(value: unknown, book: Book): value is BookContent {
  if (!value || typeof value !== 'object') return false;
  const content = value as Partial<BookContent>;
  if (content.id !== book.id || content.version !== book.version || !Array.isArray(content.chapters) || !content.chapters.length) return false;
  const ids = new Set<string>();
  for (const chapter of content.chapters) {
    if (!chapter || typeof chapter.id !== 'string' || !chapter.id || ids.has(chapter.id) || typeof chapter.title !== 'string' || !Array.isArray(chapter.paragraphs) || !chapter.paragraphs.length) return false;
    ids.add(chapter.id);
    for (const paragraph of chapter.paragraphs) {
      if (!paragraph || typeof paragraph.id !== 'string' || !paragraph.id || ids.has(paragraph.id) || typeof paragraph.text !== 'string' || !paragraph.text.trim()) return false;
      ids.add(paragraph.id);
    }
  }
  return true;
}
export async function verifiedResponse(book: Book, response: Response, onProgress?: (percent: number) => void): Promise<Response> {
  if (!crypto.subtle) throw new Error(secureBookMessage);
  if (!response.ok) throw new Error('Не удалось получить книгу. Проверь соединение и попробуй ещё раз.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > book.bytes) throw new Error('Размер книги не совпадает с манифестом. Повтори загрузку.');
        chunks.push(value);
        // 100% is reported only after the digest and format have been verified.
        onProgress?.(Math.min(99, Math.floor(size / book.bytes * 100)));
      }
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
  }
  if (size !== book.bytes) throw new Error('Книга загрузилась не полностью. Проверь соединение и попробуй снова.');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
  if (hash !== book.sha256) throw new Error('Версия книги не прошла проверку. Загрузи её заново.');
  let content: unknown;
  try { content = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('Неподдерживаемый формат книги.'); }
  if (!isBookContent(content, book)) throw new Error('Неподдерживаемый формат книги.');
  onProgress?.(100);
  return new Response(bytes, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
export async function loadBook(book: Book): Promise<BookContent> {
  requireBookStorage();
  const cache = await caches.open(BOOK_CACHE);
  const cached = await cache.match(book.url);
  if (cached) {
    try { return await (await verifiedResponse(book, cached)).json(); }
    catch { await cache.delete(book.url); await db.downloads.delete(book.id); }
  } else await db.downloads.delete(book.id);
  return (await verifiedResponse(book, await fetch(book.url))).json();
}
export async function downloadBook(book: Book, onProgress?: (percent: number) => void) {
  requireBookStorage();
  const cache = await caches.open(BOOK_CACHE);
  try {
    const response = await verifiedResponse(book, await fetch(book.url), onProgress);
    await cache.put(book.url, response);
    await db.downloads.put({ bookId: book.id, version: book.version, hash: book.sha256, bytes: book.bytes });
  } catch (error) {
    // A retry that fails must not delete an earlier verified copy.
    if (error instanceof DOMException && error.name === 'QuotaExceededError') throw new Error('На устройстве недостаточно места. Удали ненужные загрузки и попробуй снова.');
    throw error;
  }
  await navigator.storage?.persist?.().catch(() => false);
}
export async function removeDownload(book: Book) {
  requireBookStorage();
  await (await caches.open(BOOK_CACHE)).delete(book.url);
  await db.downloads.delete(book.id);
}
export async function reconcileDownloads(books: Book[]) {
  // Unavailable browser APIs do not mean saved books have been evicted.
  if (typeof caches === 'undefined' || !crypto.subtle) return;
  const cache = await caches.open(BOOK_CACHE);
  for (const item of await db.downloads.toArray()) {
    const book = books.find(b => b.id === item.bookId);
    const cached = book && await cache.match(book.url);
    if (!book || book.version !== item.version || !cached) {
      await db.downloads.delete(item.bookId);
      continue;
    }
    try { await verifiedResponse(book, cached); }
    catch { await cache.delete(book.url); await db.downloads.delete(item.bookId); }
  }
}
