import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { LocalDatabase, savePosition, toggleBookmark, saveReadingSession, toggleShelf } from './db';
import { accountSaveHeading, accountSaveStatus } from './account-save-status';
const store = new LocalDatabase('save-status-a', 'account:a');
const other = new LocalDatabase('save-status-b', 'account:b');
const guest = new LocalDatabase('save-status-guest');
const position = { bookId: 'book', version: '1', chapter: 0, paragraph: 'p1', offset: .3, updatedAt: 'now' };
afterEach(async () => { await Promise.all([store.delete(), other.delete(), guest.delete()]); await Promise.all([store.open(), other.open(), guest.open()]); });
it('counts local account changes, including sending operations and deletion tombstones', async () => {
 await savePosition(position, store);
 await toggleBookmark(position, 'chapter', store);
 await toggleBookmark(position, 'chapter', store);
 await saveReadingSession({ id: 'session', bookId: 'book', day: '2026-11-13', seconds: 60 }, store);
 await toggleShelf('book', store);
 await store.outbox.toCollection().modify({ state: 'sending' });
 const status = await accountSaveStatus(store);
 expect(status).toEqual({ positions: 1, bookmarks: 1, sessions: 1, other: 1, total: 4, choices: 0, conflicts: 0 });
 expect(accountSaveHeading(status)).toBe('Сохранено на устройстве');
});
it('prioritizes persisted conflicts and uncertain saves after reopen', async () => {
 await store.positionChoices.put({ bookId: 'book', choice: { operationId: 'op', expectedRevision: 1, position }, conflict: false });
 expect(accountSaveHeading(await accountSaveStatus(store))).toBe('Сохранение места не подтверждено');
 await store.positionChoices.update('book', { conflict: true });
 store.close(); await store.open();
 expect((await accountSaveStatus(store)).conflicts).toBe(1);
 expect(accountSaveHeading(await accountSaveStatus(store))).toBe('Есть конфликт мест чтения');
});
it('keeps accounts and guest reading separate and never calls an empty queue synchronized', async () => {
 await savePosition(position, other);
 await savePosition(position, guest);
 const status = await accountSaveStatus(store);
 expect(status.total).toBe(0);
 expect(accountSaveHeading(status)).toBe('Нет изменений, ожидающих отправки');
 await expect(accountSaveStatus(guest)).rejects.toThrow('Нужно войти');
});
