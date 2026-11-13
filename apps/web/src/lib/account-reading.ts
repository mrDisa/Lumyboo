import { LocalDatabase, bookmarkId, type Position } from './db';
import type { BookContent } from './books';
import type { AccountPosition, ReadingLocator } from './positions';
import type { BookmarkEntry } from './bookmarks';
const databases = new Map<string, LocalDatabase>();
export function accountDatabase(accountId: string) {
 if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(accountId)) throw new Error('Не удалось определить аккаунт. Войди заново.');
 let store = databases.get(accountId);
 if (!store) { store = new LocalDatabase(`lumyboo-account-${accountId}`, `account:${accountId}`); databases.set(accountId, store); }
 return store;
}
export function validReadingLocator(p: ReadingLocator, content: BookContent) {
 return p.bookId === content.id && p.version === content.version && Number.isInteger(p.chapter) && p.chapter >= 0 && p.chapter < content.chapters.length && Number.isFinite(p.offset) && p.offset >= 0 && p.offset < 1 && content.chapters[p.chapter].paragraphs.some(paragraph => paragraph.id === p.paragraph);
}
// Called after a fresh session check and, when needed, an explicit local/server
// choice. All writes remain inside the captured account database.
export async function prepareAccountBook(store: LocalDatabase, content: BookContent, remote: AccountPosition | undefined, bookmarks: BookmarkEntry[], useRemote: boolean, expectedLocal: Position | undefined) {
 if (store.scope === 'guest') throw new Error('Для аккаунта нужно отдельное хранилище.');
 return store.transaction('rw', [store.positions, store.positionHistory, store.bookmarks, store.outbox, store.positionChoices], async () => {
  const current = await store.positions.get(content.id);
  if (JSON.stringify(current) !== JSON.stringify(expectedLocal)) throw new Error('Место на устройстве изменилось в другой вкладке. Открой книгу заново.');
  if (useRemote && remote) {
   // A lost response may already have changed the server. Do not adopt a
   // snapshot while an older explicit choice can still be retried. Check in
   // this transaction too: another tab may have saved a choice after loading.
   if (await store.positionChoices.get(content.id)) throw new Error('Для этой книги есть незавершённое сохранение. Проверь его в профиле, прежде чем выбирать место аккаунта.');
   if (!validReadingLocator(remote, content)) throw new Error('Место аккаунта относится к другому изданию или недоступному фрагменту.');
   if (current) await store.positionHistory.put({ ...current, id: `choice:${crypto.randomUUID()}` });
   await store.positions.put({ bookId: remote.bookId, version: remote.version, chapter: remote.chapter, paragraph: remote.paragraph, offset: remote.offset, updatedAt: new Date().toISOString() });
   // The confirmed server snapshot supersedes only the pending local position
   // explicitly reviewed by the user. Other books/operations remain intact.
   await store.outbox.where('[entity+state]').equals([`position:${content.id}`, 'pending']).delete();
  }
  const remoteIds = new Set(bookmarks.filter(entry => validReadingLocator(entry, content)).map(bookmarkId));
  const existing = await store.bookmarks.where('bookId').equals(content.id).filter(entry => entry.version === content.version).toArray();
  for (const entry of existing) {
   if (remoteIds.has(entry.id)) continue;
   const changes = await store.outbox.where('[entity+state]').anyOf([[`bookmark:${entry.id}`, 'pending'], [`bookmark:${entry.id}`, 'sending']]).count();
   if (!changes) await store.bookmarks.delete(entry.id);
  }
  for (const entry of bookmarks) {
   if (!validReadingLocator(entry, content)) continue;
   const id = bookmarkId(entry);
   const pending = await store.outbox.where('[entity+state]').equals([`bookmark:${id}`, 'pending']).first();
   const sending = await store.outbox.where('[entity+state]').equals([`bookmark:${id}`, 'sending']).first();
   if (pending || sending) continue;
   await store.bookmarks.put({ ...entry, id, updatedAt: new Date().toISOString() });
  }
 });
}
