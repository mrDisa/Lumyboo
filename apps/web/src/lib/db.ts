import { randomId } from './random-id';
import Dexie, { type Table } from 'dexie';
import type { DailyGoal } from './daily-goal';
import type { AccountPosition, PositionChoice } from './positions';
import type { BookmarkChange } from './bookmarks';
import type { ParagraphCoverage } from './reading-coverage';
import type { CoverageReport } from './reading-coverage-sync';
export interface SavedBookmarkChoice { id: string; change: BookmarkChange; conflict: boolean; coveredOperationIds: string[] }
export interface SavedPositionChoice { bookId: string; choice: PositionChoice; remote?: AccountPosition; conflict: boolean; coveredPositionOperationIds?: string[] }
export interface Settings { id: 'local'; theme: 'system' | 'light' | 'dark'; fontSize: number; font: 'serif' | 'sans'; lineHeight: number; onboarded: boolean; currentBook?: string; name: string }
export interface Position { bookId: string; version: string; chapter: number; paragraph: string; offset: number; updatedAt: string }
export interface Bookmark extends Position { id: string; label: string }
export interface ReadingSession { id: string; bookId: string; day: string; seconds: number; version?: string; deviceId?: string }
export type LocalChange =
  | { type: 'settings.put'; key: string; value: Settings }
  | { type: 'shelf.put'; key: string; value: { bookId: string } }
  | { type: 'shelf.delete'; key: string }
  | { type: 'position.put'; key: string; value: Position }
  | { type: 'bookmark.put'; key: string; value: Bookmark }
  | { type: 'bookmark.delete'; key: string }
  | { type: 'session.put'; key: string; value: ReadingSession }
  | { type: 'coverage.put'; key: string; value: CoverageReport };
export type OperationScope = 'guest' | `account:${string}`;
export interface PendingOperation { id: string; formatVersion: 1; scope: OperationScope; deviceId: string; sequence: number; entity: string; state: 'pending' | 'sending'; change: LocalChange }
export interface Download { bookId: string; version: string; bytes: number; hash: string }
export const defaults: Settings = { id: 'local', theme: 'system', fontSize: 18, font: 'serif', lineHeight: 1.95, onboarded: false, name: '' };
export class LocalDatabase extends Dexie {
  guestTimeImports!: Table<import('./guest-time-import').TimeImportBatch, string>;
  dailyGoals!: Table<DailyGoal, string>;
  bookmarkChoices!: Table<SavedBookmarkChoice, string>;
  positionChoices!: Table<SavedPositionChoice, string>;
  outbox!: Table<PendingOperation, string>;
  metadata!: Table<{ id: string; deviceId: string; sequence: number }, string>;
  settings!: Table<Settings, string>;
  positions!: Table<Position, string>;
  bookmarks!: Table<Bookmark, string>;
  positionHistory!: Table<Position & { id: string }, string>;
  shelf!: Table<{ bookId: string }, string>;
  downloads!: Table<Download, string>;
  sessions!: Table<ReadingSession, string>;
  coverage!: Table<ParagraphCoverage, [string, string, string]>;
  constructor(name = 'lumyboo-local-v1', public readonly scope: OperationScope = 'guest') {
    super(name);
    this.version(1).stores({ settings: 'id', positions: 'bookId', bookmarks: 'id, bookId', shelf: 'bookId', downloads: 'bookId', sessions: 'id, day, bookId' });
    this.version(2).stores({ positionHistory: 'id, bookId, [bookId+version]' });
    this.version(3).stores({ outbox: 'id, sequence, [entity+state]', metadata: 'id' });
    this.version(4).stores({ positionChoices: 'bookId' });
    this.version(5).stores({ bookmarkChoices: 'id' });
    this.version(6).stores({ coverage: '[bookId+version+paragraph], [bookId+version]' });
    this.version(7).stores({ dailyGoals: 'id' });
    this.version(8).stores({ guestTimeImports: 'id' });
  }
}
export const db = new LocalDatabase();
export async function setSettings(patch: Partial<Omit<Settings, 'id'>>, store: LocalDatabase = db) {
  await store.transaction('rw', [store.settings, store.outbox, store.metadata], async () => {
    const value: Settings = { ...defaults, ...await store.settings.get('local'), ...patch, id: 'local' };
    if (JSON.stringify(value) === JSON.stringify(await store.settings.get('local'))) return;
    await store.settings.put(value);
    await enqueue({ type: 'settings.put', key: 'local', value }, store);
  });
}
export async function toggleShelf(bookId: string, store: LocalDatabase = db) {
  await store.transaction('rw', [store.shelf, store.outbox, store.metadata], async () => {
    if (await store.shelf.get(bookId)) {
      await store.shelf.delete(bookId);
      await enqueue({ type: 'shelf.delete', key: bookId }, store);
    } else {
      await store.shelf.put({ bookId });
      await enqueue({ type: 'shelf.put', key: bookId, value: { bookId } }, store);
    }
  });
}
export function bookmarkId(p: Pick<Position, 'bookId' | 'version' | 'paragraph'>) { return `${p.bookId}:${p.version}:${p.paragraph}`; }
export async function toggleBookmark(p: Position, label: string, store: LocalDatabase = db) {
  const id = bookmarkId(p);
  await store.transaction('rw', [store.bookmarks, store.outbox, store.metadata], async () => {
    if (await store.bookmarks.get(id)) {
      await store.bookmarks.delete(id);
      await enqueue({ type: 'bookmark.delete', key: id }, store);
    } else {
      const value = { ...p, id, label };
      await store.bookmarks.put(value);
      await enqueue({ type: 'bookmark.put', key: id, value }, store);
    }
  });
}

export async function loadPosition(bookId: string, version: string, store: LocalDatabase = db) {
  return store.transaction('rw', store.positions, store.positionHistory, async () => {
    const saved = await store.positions.get(bookId);
    if (saved && saved.version !== version) {
      await store.positionHistory.put({ ...saved, id: `${bookId}:${saved.version}` });
    }
    return saved;
  });
}

// Called inside the local write transaction; ownership is fixed by the
// database instance, never by whichever cookie happens to be current.
export async function enqueue(change: LocalChange, store: LocalDatabase = db) {
  const meta = await store.metadata.get('device') ?? { id: 'device', deviceId: randomId(), sequence: 0 };
  meta.sequence += 1;
  await store.metadata.put(meta);
  const entity = `${change.type.split('.')[0]}:${change.key}`;
  // Only unsent snapshots can be superseded. Sending operations stay immutable
  // so a lost response can later be retried with the same operation ID.
  await store.outbox.where('[entity+state]').equals([entity, 'pending']).delete();
  await store.outbox.add({ id: randomId(), formatVersion: 1, scope: store.scope, deviceId: meta.deviceId, sequence: meta.sequence, entity, state: 'pending', change });
}
export async function deleteBookmark(id: string, store: LocalDatabase = db) {
  await store.transaction('rw', [store.bookmarks, store.outbox, store.metadata], async () => {
    if (!await store.bookmarks.get(id)) return;
    await store.bookmarks.delete(id);
    await enqueue({ type: 'bookmark.delete', key: id }, store);
  });
}
export async function savePosition(value: Position, store: LocalDatabase = db) {
  await store.transaction('rw', [store.positions, store.outbox, store.metadata], async () => {
    if (JSON.stringify(await store.positions.get(value.bookId)) === JSON.stringify(value)) return;
    await store.positions.put(value);
    await enqueue({ type: 'position.put', key: value.bookId, value }, store);
  });
}
export async function saveReadingSession(value: ReadingSession, store: LocalDatabase = db) {
  await store.transaction('rw', [store.sessions, store.outbox, store.metadata], async () => {
    const previous = await store.sessions.get(value.id);
    if (!Number.isFinite(value.seconds) || value.seconds < 0 || value.seconds > 86400) throw new Error('Некорректное время чтения.');
    if (previous && (previous.bookId !== value.bookId || previous.day !== value.day || previous.version !== value.version || value.deviceId && previous.deviceId !== value.deviceId)) throw new Error('Данные сессии чтения изменились. Открой книгу заново.');
    if (previous && previous.seconds >= value.seconds || !previous && value.seconds <= 0) return;
    // Metadata is attached only at creation with a known edition. Old sessions
    // remain unchanged; an edition must never be inferred during migration.
    let deviceId = previous?.deviceId;
    if (!previous && value.version) {
      const meta = await store.metadata.get('device') ?? { id: 'device', deviceId: randomId(), sequence: 0 };
      await store.metadata.put(meta);
      deviceId = meta.deviceId;
    }
    const row = deviceId ? { ...value, deviceId } : value;
    await store.sessions.put(row);
    await enqueue({ type: 'session.put', key: value.id, value: row }, store);
  });
}
