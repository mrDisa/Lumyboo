import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { LocalDatabase, saveReadingSession } from './db';
import { loadLocalReadingTime } from './local-reading-time';

it('combines books, editions and legacy guest sessions by day without double counting snapshots or mutating the queue', async () => {
 const store = new LocalDatabase(`daily-${crypto.randomUUID()}`);
 try {
  const base = { id: 'one', bookId: 'book', version: '1', day: '2026-01-01', seconds: .601 };
  await saveReadingSession(base, store);
  await saveReadingSession({ ...base, seconds: 10 }, store);
  await saveReadingSession({ ...base, id: 'edition', version: '2', seconds: 20 }, store);
  await saveReadingSession({ ...base, id: 'other', bookId: 'other', seconds: 30 }, store);
  await store.sessions.put({ ...base, id: 'legacy', version: undefined, seconds: 1 });
  for (let i = 0; i < 100; i++) await saveReadingSession({ ...base, id: `short-${i}`, day: '2025-12-31', seconds: .601 }, store);
  await saveReadingSession({ ...base, id: 'zero', day: '2026-01-02', seconds: 0 }, store);
  const before = { outbox: await store.outbox.toArray(), metadata: await store.metadata.toArray() };
  expect(await loadLocalReadingTime(store, '2026-01-01')).toEqual({
   total: 121.1, today: 61, bookmarks: 0,
   days: [{ day: '2026-01-01', seconds: 61 }, { day: '2025-12-31', seconds: 60.1 }],
  });
  expect((await loadLocalReadingTime(store, '2026-01-02')).today).toBe(0);
  expect({ outbox: await store.outbox.toArray(), metadata: await store.metadata.toArray() }).toEqual(before);
 } finally { await store.delete(); }
});

it('keeps guest history separate from account histories across reopen and exposes storage failures', async () => {
 const guest = new LocalDatabase(`daily-${crypto.randomUUID()}`);
 const account = new LocalDatabase(`daily-${crypto.randomUUID()}`, 'account:a');
 try {
  expect(await loadLocalReadingTime(guest, '2026-11-13')).toEqual({ total: 0, today: 0, days: [], bookmarks: 0 });
  await saveReadingSession({ id: 'one', bookId: 'book', day: '2026-11-13', seconds: 10 }, guest);
  await saveReadingSession({ id: 'one', bookId: 'book', day: '2026-11-13', seconds: 100 }, account);
  guest.close(); await guest.open();
  expect((await loadLocalReadingTime(guest, '2026-11-13')).total).toBe(10);
  expect((await loadLocalReadingTime(account, '2026-11-13')).total).toBe(100);
  guest.close({ disableAutoOpen: true });
  await expect(loadLocalReadingTime(guest, '2026-11-13')).rejects.toThrow();
  await guest.open();
  expect((await loadLocalReadingTime(guest, '2026-11-13')).today).toBe(10);
 } finally { await guest.delete(); await account.delete(); }
});
