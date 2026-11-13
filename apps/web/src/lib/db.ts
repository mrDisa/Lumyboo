import Dexie, { type Table } from 'dexie';
export interface Settings { id: 'local'; theme: 'system' | 'light' | 'dark'; fontSize: number; font: 'serif' | 'sans'; lineHeight: number; onboarded: boolean; currentBook?: string; name: string }
export interface Position { bookId: string; version: string; chapter: number; paragraph: string; offset: number; updatedAt: string }
export interface Bookmark extends Position { id: string; label: string }
export interface ReadingSession { id: string; bookId: string; day: string; seconds: number }
export interface Download { bookId: string; version: string; bytes: number; hash: string }
export const defaults: Settings = { id: 'local', theme: 'system', fontSize: 18, font: 'serif', lineHeight: 1.95, onboarded: false, name: '' };
export class LocalDatabase extends Dexie {
  settings!: Table<Settings, string>;
  positions!: Table<Position, string>;
  bookmarks!: Table<Bookmark, string>;
  positionHistory!: Table<Position & { id: string }, string>;
  shelf!: Table<{ bookId: string }, string>;
  downloads!: Table<Download, string>;
  sessions!: Table<ReadingSession, string>;
  constructor(name = 'lumyboo-local-v1') {
    super(name);
    this.version(1).stores({ settings: 'id', positions: 'bookId', bookmarks: 'id, bookId', shelf: 'bookId', downloads: 'bookId', sessions: 'id, day, bookId' });
    this.version(2).stores({ positionHistory: 'id, bookId, [bookId+version]' });
  }
}
export const db = new LocalDatabase();
export async function setSettings(patch: Partial<Omit<Settings, 'id'>>) {
  await db.transaction('rw', db.settings, async () => {
    await db.settings.put({ ...defaults, ...await db.settings.get('local'), ...patch, id: 'local' });
  });
}
export async function toggleShelf(bookId: string) {
  await db.transaction('rw', db.shelf, async () => {
    if (await db.shelf.get(bookId)) await db.shelf.delete(bookId);
    else await db.shelf.put({ bookId });
  });
}
export function bookmarkId(p: Position) { return `${p.bookId}:${p.version}:${p.paragraph}`; }
export async function toggleBookmark(p: Position, label: string) {
  const id = bookmarkId(p);
  await db.transaction('rw', db.bookmarks, async () => {
    if (await db.bookmarks.get(id)) await db.bookmarks.delete(id);
    else await db.bookmarks.put({ ...p, id, label });
  });
}

export async function loadPosition(bookId: string, version: string) {
  return db.transaction('rw', db.positions, db.positionHistory, async () => {
    const saved = await db.positions.get(bookId);
    if (saved && saved.version !== version) {
      await db.positionHistory.put({ ...saved, id: `${bookId}:${saved.version}` });
    }
    return saved;
  });
}
