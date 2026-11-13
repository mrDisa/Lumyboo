import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, expect, it } from 'vitest';
import { db, LocalDatabase, toggleShelf, toggleBookmark, deleteBookmark, savePosition, saveReadingSession, setSettings, type Position } from './db';
const position: Position = { bookId: 'book', version: '1', chapter: 0, paragraph: 'p1', offset: .2, updatedAt: '2026-11-13T00:00:00Z' };
afterEach(async () => { await db.delete(); await db.open(); });

it('rolls back local changes and device metadata when queuing fails', async () => {
  const fail = () => { throw new Error('Storage full'); };
  db.outbox.hook('creating', fail);
  try { await expect(toggleShelf('book')).rejects.toThrow('Storage full'); }
  finally { db.outbox.hook('creating').unsubscribe(fail); }
  expect(await db.shelf.count()).toBe(0);
  expect(await db.metadata.count()).toBe(0);
  expect(await db.outbox.count()).toBe(0);
});

it('persists guest operations, their order and device identity across reopen', async () => {
  await Promise.all([toggleShelf('book'), setSettings({ theme: 'dark' })]);
  await savePosition(position);
  await toggleBookmark(position, 'Chapter');
  await saveReadingSession({ id: 'session', bookId: 'book', day: '2026-11-13', seconds: 12 });
  db.close(); await db.open();
  const operations = await db.outbox.orderBy('sequence').toArray();
  expect(operations).toHaveLength(5);
  expect(operations.map(o => o.sequence)).toEqual([1, 2, 3, 4, 5]);
  expect(new Set(operations.map(o => o.deviceId)).size).toBe(1);
  expect(new Set(operations.map(o => o.id)).size).toBe(5);
  expect(operations.every(o => o.scope === 'guest' && o.formatVersion === 1 && o.state === 'pending')).toBe(true);
  await deleteBookmark((await db.bookmarks.toArray())[0].id);
  expect((await db.outbox.orderBy('sequence').last())?.change.type).toBe('bookmark.delete');
  expect(await db.bookmarks.count()).toBe(0);
});

it('compacts only unsent snapshots and keeps sending operations immutable', async () => {
  await savePosition(position);
  const original = (await db.outbox.toArray())[0];
  await db.outbox.update(original.id, { state: 'sending' });
  await savePosition({ ...position, offset: .4 });
  await savePosition({ ...position, offset: .6 });
  expect(await db.outbox.count()).toBe(2);
  expect(await db.outbox.get(original.id)).toEqual({ ...original, state: 'sending' });
  const pending = await db.outbox.where('[entity+state]').equals(['position:book', 'pending']).first();
  expect(pending?.change).toMatchObject({ type: 'position.put', value: { offset: .6 } });
  expect(pending?.sequence).toBe(3);
});

it('retains deletions and ignores repeated or older session snapshots', async () => {
  await toggleShelf('book'); await toggleShelf('book');
  expect((await db.outbox.toArray())[0].change).toEqual({ type: 'shelf.delete', key: 'book' });
  const session = { id: 'session', bookId: 'book', day: '2026-11-13', seconds: 20 };
  await saveReadingSession(session);
  const before = await db.outbox.toArray();
  await saveReadingSession(session);
  await saveReadingSession({ ...session, seconds: 10 });
  expect(await db.outbox.toArray()).toEqual(before);
  expect((await db.sessions.get('session'))?.seconds).toBe(20);
});

it('upgrades v2 without relabeling existing guest data as account operations', async () => {
  const name = 'lumyboo-outbox-upgrade';
  const old = new Dexie(name);
  old.version(2).stores({ settings: 'id', positions: 'bookId', bookmarks: 'id, bookId', shelf: 'bookId', downloads: 'bookId', sessions: 'id, day, bookId', positionHistory: 'id, bookId, [bookId+version]' });
  const upgraded = new LocalDatabase(name);
  try {
    await old.table('positions').put(position); old.close();
    await upgraded.open();
    expect(await upgraded.positions.get('book')).toEqual(position);
    expect(await upgraded.outbox.count()).toBe(0);
    expect(await upgraded.metadata.count()).toBe(0);
  } finally { old.close(); await upgraded.delete(); }
});
