import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { LocalDatabase, saveReadingSession, type OperationScope } from './db';
import { loadBookReadingTime } from './book-reading-time';

it('counts saved cumulative snapshots once and separates books, editions and days without changing the queue', async () => {
 const store = new LocalDatabase(`time-${crypto.randomUUID()}`);
 try {
  const row = { id: 'one', bookId: 'book', version: '1', day: '2026-11-13', seconds: 10 };
  await saveReadingSession(row, store);
  await saveReadingSession({ ...row, seconds: 60 }, store);
  await saveReadingSession({ ...row, id: 'yesterday', day: '2026-11-12', seconds: 20.123 }, store);
  await saveReadingSession({ ...row, id: 'edition', version: '2', seconds: 100 }, store);
  await saveReadingSession({ ...row, id: 'other', bookId: 'other', seconds: 100 }, store);
  await store.sessions.put({ ...row, id: 'legacy', version: undefined, seconds: 100 });
  const before = await store.outbox.toArray();
  expect(await loadBookReadingTime(store, 'book', '1', '2026-11-13')).toEqual({ total: 80.123, today: 60, days: [{ day: '2026-11-13', seconds: 60 }, { day: '2026-11-12', seconds: 20.123 }] });
  expect(await loadBookReadingTime(store, 'book', '1', '2026-11-14')).toEqual({ total: 80.123, today: 0, days: [{ day: '2026-11-13', seconds: 60 }, { day: '2026-11-12', seconds: 20.123 }] });
  expect(await loadBookReadingTime(store, 'empty', '1', '2026-11-13')).toEqual({ total: 0, today: 0, days: [] });
  expect(await store.outbox.toArray()).toEqual(before);
 } finally { await store.delete(); }
});

it('keeps guest and two account totals separate after reopening the database', async () => {
 const stores = ['guest', 'account:a', 'account:b'].map(scope => new LocalDatabase(`time-${crypto.randomUUID()}`, scope as OperationScope));
 try {
  for (const [i, store] of stores.entries()) await saveReadingSession({ id: 'same', bookId: 'book', version: '1', day: '2026-11-13', seconds: i + 1 }, store);
  for (const [i, store] of stores.entries()) {
   store.close(); await store.open();
   expect(await loadBookReadingTime(store, 'book', '1', '2026-11-13')).toEqual({ total: i + 1, today: i + 1, days: [{ day: '2026-11-13', seconds: i + 1 }] });
  }
 } finally { await Promise.all(stores.map(store => store.delete())); }
});

it('groups short sessions by their recorded day, sorts across years and updates without adding zero-only days', async () => {
 const store = new LocalDatabase(`time-${crypto.randomUUID()}`);
 try {
  const base = { bookId: 'book', version: '1' };
  await saveReadingSession({ ...base, id: 'old', day: '2025-12-31', seconds: 12 }, store);
  for (let i = 0; i < 100; i++) await saveReadingSession({ ...base, id: `short-${i}`, day: '2026-01-01', seconds: .601 }, store);
  await saveReadingSession({ ...base, id: 'zero', day: '2026-01-02', seconds: 0 }, store);
  const before = await store.outbox.toArray();
  expect(await loadBookReadingTime(store, 'book', '1', '2026-01-01')).toEqual({
   total: 72.1, today: 60.1, days: [{ day: '2026-01-01', seconds: 60.1 }, { day: '2025-12-31', seconds: 12 }],
  });
  expect(await store.outbox.toArray()).toEqual(before);
  await saveReadingSession({ ...base, id: 'old', day: '2025-12-31', seconds: 20 }, store);
  expect((await loadBookReadingTime(store, 'book', '1', '2026-01-02')).days).toEqual([
   { day: '2026-01-01', seconds: 60.1 }, { day: '2025-12-31', seconds: 20 },
  ]);
 } finally { await store.delete(); }
});
