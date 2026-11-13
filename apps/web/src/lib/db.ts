import Dexie, { type Table } from 'dexie';
export interface Settings { id: 'local'; theme: 'system' | 'light' | 'dark'; fontSize: number; font: 'serif' | 'sans'; lineHeight: number; onboarded: boolean; currentBook?: string; name: string }
export interface Position { bookId: string; version: string; chapter: number; paragraph: string; offset: number; updatedAt: string }
export interface Bookmark extends Position { id: string; label: string }
export interface ReadingSession { id: string; bookId: string; day: string; seconds: number }
export type LocalChange =
  | { type: 'settings.put'; key: string; value: Settings }
  | { type: 'shelf.put'; key: string; value: { bookId: string } }
  | { type: 'shelf.delete'; key: string }
  | { type: 'position.put'; key: string; value: Position }
  | { type: 'bookmark.put'; key: string; value: Bookmark }
  | { type: 'bookmark.delete'; key: string }
  | { type: 'session.put'; key: string; value: ReadingSession };
export interface PendingOperation { id: string; formatVersion: 1; scope: 'guest'; deviceId: string; sequence: number; entity: string; state: 'pending' | 'sending'; change: LocalChange }
export interface Download { bookId: string; version: string; bytes: number; hash: string }
export const defaults: Settings = { id: 'local', theme: 'system', fontSize: 18, font: 'serif', lineHeight: 1.95, onboarded: false, name: '' };
export class LocalDatabase extends Dexie {
  outbox!: Table<PendingOperation, string>;
  metadata!: Table<{ id: string; deviceId: string; sequence: number }, string>;
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
    this.version(3).stores({ outbox: 'id, sequence, [entity+state]', metadata: 'id' });
  }
}
export const db = new LocalDatabase();
export async function setSettings(patch: Partial<Omit<Settings, 'id'>>) {
  await db.transaction('rw', [db.settings, db.outbox, db.metadata], async () => {
    const value: Settings = { ...defaults, ...await db.settings.get('local'), ...patch, id: 'local' };
    if (JSON.stringify(value) === JSON.stringify(await db.settings.get('local'))) return;
    await db.settings.put(value);
    await enqueue({ type: 'settings.put', key: 'local', value });
  });
}
export async function toggleShelf(bookId: string) {
  await db.transaction('rw', [db.shelf, db.outbox, db.metadata], async () => {
    if (await db.shelf.get(bookId)) {
      await db.shelf.delete(bookId);
      await enqueue({ type: 'shelf.delete', key: bookId });
    } else {
      await db.shelf.put({ bookId });
      await enqueue({ type: 'shelf.put', key: bookId, value: { bookId } });
    }
  });
}
export function bookmarkId(p: Position) { return `${p.bookId}:${p.version}:${p.paragraph}`; }
export async function toggleBookmark(p: Position, label: string) {
  const id = bookmarkId(p);
  await db.transaction('rw', [db.bookmarks, db.outbox, db.metadata], async () => {
    if (await db.bookmarks.get(id)) {
      await db.bookmarks.delete(id);
      await enqueue({ type: 'bookmark.delete', key: id });
    } else {
      const value = { ...p, id, label };
      await db.bookmarks.put(value);
      await enqueue({ type: 'bookmark.put', key: id, value });
    }
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

// Called only inside the same transaction as the local write. Guest operations
// must never be sent under whichever account happens to be signed in.
async function enqueue(change: LocalChange) {
  const meta = await db.metadata.get('device') ?? { id: 'device', deviceId: crypto.randomUUID(), sequence: 0 };
  meta.sequence += 1;
  await db.metadata.put(meta);
  const entity = `${change.type.split('.')[0]}:${change.key}`;
  // Only unsent snapshots can be superseded. Sending operations stay immutable
  // so a lost response can later be retried with the same operation ID.
  await db.outbox.where('[entity+state]').equals([entity, 'pending']).delete();
  await db.outbox.add({ id: crypto.randomUUID(), formatVersion: 1, scope: 'guest', deviceId: meta.deviceId, sequence: meta.sequence, entity, state: 'pending', change });
}
export async function deleteBookmark(id: string) {
  await db.transaction('rw', [db.bookmarks, db.outbox, db.metadata], async () => {
    if (!await db.bookmarks.get(id)) return;
    await db.bookmarks.delete(id);
    await enqueue({ type: 'bookmark.delete', key: id });
  });
}
export async function savePosition(value: Position) {
  await db.transaction('rw', [db.positions, db.outbox, db.metadata], async () => {
    if (JSON.stringify(await db.positions.get(value.bookId)) === JSON.stringify(value)) return;
    await db.positions.put(value);
    await enqueue({ type: 'position.put', key: value.bookId, value });
  });
}
export async function saveReadingSession(value: ReadingSession) {
  await db.transaction('rw', [db.sessions, db.outbox, db.metadata], async () => {
    const previous = await db.sessions.get(value.id);
    if (previous && previous.seconds >= value.seconds || !previous && value.seconds <= 0) return;
    await db.sessions.put(value);
    await enqueue({ type: 'session.put', key: value.id, value });
  });
}
