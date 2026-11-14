import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { liveQuery } from 'dexie';
import { LocalDatabase, saveReadingSession } from './db';
import { loadLocalReadingDay, loadLocalReadingTime } from './local-reading-time';

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

it('updates account daily history from saved sessions while isolating another account and preserving pending operations', async () => {
 const account = new LocalDatabase(`daily-${crypto.randomUUID()}`, 'account:a');
 const other = new LocalDatabase(`daily-${crypto.randomUUID()}`, 'account:b');
 let latest: Awaited<ReturnType<typeof loadLocalReadingTime>> | undefined;
 const subscription = liveQuery(() => loadLocalReadingTime(account, '2026-11-13')).subscribe(value => { latest = value; });
 try {
  await vi.waitFor(() => expect(latest?.days).toEqual([]));
  const base = { id: 'same', bookId: 'book', version: '1', day: '2026-11-13', seconds: 60 };
  await saveReadingSession(base, account);
  await saveReadingSession({ ...base, seconds: 9000 }, other);
  await saveReadingSession({ ...base, seconds: 90 }, account);
  await saveReadingSession({ ...base, id: 'edition', version: '2', seconds: 30 }, account);
  await account.sessions.put({ ...base, id: 'legacy', version: undefined, day: '2026-11-12', seconds: 10 });
  const pending = await account.outbox.toArray();
  expect(pending.length).toBeGreaterThan(0);
  await vi.waitFor(() => expect(latest).toEqual({ total: 130, today: 120, bookmarks: 0,
   days: [{ day: '2026-11-13', seconds: 120 }, { day: '2026-11-12', seconds: 10 }],
  }));
  expect(await account.outbox.toArray()).toEqual(pending);
  account.close(); await account.open();
  expect(await loadLocalReadingTime(account, '2026-11-14')).toEqual({ ...latest, today: 0 });
  expect((await loadLocalReadingTime(other, '2026-11-13')).total).toBe(9000);
 } finally { subscription.unsubscribe(); await account.delete(); await other.delete(); }
});

it('breaks a day into distinct book editions, preserving legacy sessions and exact milliseconds without changing pending work', async () => {
 const store = new LocalDatabase(`day-books-${crypto.randomUUID()}`, 'account:a');
 try {
  const base = { id: 'one', bookId: 'book', version: '1', day: '2026-11-13', seconds: 10 };
  await saveReadingSession(base, store);
  await saveReadingSession({ ...base, seconds: 20 }, store);
  await saveReadingSession({ ...base, id: 'edition', version: '2', seconds: 30 }, store);
  await store.sessions.put({ ...base, id: 'legacy', version: undefined, seconds: 5 });
  for (let i = 0; i < 100; i++) await saveReadingSession({ ...base, id: `short-${i}`, bookId: 'other', seconds: .601 }, store);
  await saveReadingSession({ ...base, id: 'old', day: '2026-11-12', seconds: 900 }, store);
  await saveReadingSession({ ...base, id: 'zero', bookId: 'zero', seconds: 0 }, store);
  const before = { outbox: await store.outbox.toArray(), metadata: await store.metadata.toArray() };
  expect(await loadLocalReadingDay(store, base.day)).toEqual({ milliseconds: 115100, editions: [
   { bookId: 'other', version: '1', milliseconds: 60100 },
   { bookId: 'book', version: '2', milliseconds: 30000 },
   { bookId: 'book', version: '1', milliseconds: 20000 },
   { bookId: 'book', version: undefined, milliseconds: 5000 },
  ] });
  expect(await loadLocalReadingDay(store, '2026-11-14')).toEqual({ milliseconds: 0, editions: [] });
  expect({ outbox: await store.outbox.toArray(), metadata: await store.metadata.toArray() }).toEqual(before);
 } finally { await store.delete(); }
});

it('refreshes the selected day from its owner database and recovers after a storage failure', async () => {
 const store = new LocalDatabase(`day-books-${crypto.randomUUID()}`);
 const other = new LocalDatabase(`day-books-${crypto.randomUUID()}`, 'account:b');
 let latest: Awaited<ReturnType<typeof loadLocalReadingDay>> | undefined;
 const subscription = liveQuery(() => loadLocalReadingDay(store, '2026-11-13')).subscribe(value => { latest = value; });
 try {
  const base = { id: 'same', bookId: 'book', day: '2026-11-13', seconds: 10 };
  await saveReadingSession(base, store);
  await saveReadingSession({ ...base, seconds: 1000 }, other);
  await vi.waitFor(() => expect(latest?.milliseconds).toBe(10000));
  await saveReadingSession({ ...base, seconds: 60 }, store);
  await vi.waitFor(() => expect(latest?.milliseconds).toBe(60000));
  subscription.unsubscribe();
  store.close({ disableAutoOpen: true });
  await expect(loadLocalReadingDay(store, base.day)).rejects.toThrow();
  await store.open();
  expect(await loadLocalReadingDay(store, base.day)).toEqual({ milliseconds: 60000, editions: [{ bookId: 'book', version: undefined, milliseconds: 60000 }] });
 } finally { subscription.unsubscribe(); await store.delete(); await other.delete(); }
});
