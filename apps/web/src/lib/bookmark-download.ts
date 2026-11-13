import { bookmarkId, type Bookmark, type LocalDatabase } from './db';
import { bookmarkEntry, sameBookmark, type BookmarkState } from './bookmarks';
import { withBookmarkLock } from './bookmark-choices';
import { readingLockName } from './reading-ownership';
import { validReadingLocator } from './account-reading';
import { getSession } from './auth';
import type { BookContent } from './books';

export interface BookmarkDownload {
 accountId: string;
 remote: BookmarkState;
 local?: Bookmark;
 operationIds: string[];
}
function assertOwner(store: LocalDatabase, accountId: string) {
 if (store.scope !== `account:${accountId}`) throw new Error('Аккаунт изменился. Открой профиль заново.');
}
// Capture both the displayed value and its operation boundary. A delete/recreate
// can produce the same value while expressing new intent in another tab.
export async function reviewBookmarkDownload(store: LocalDatabase, accountId: string, remote: BookmarkState): Promise<BookmarkDownload> {
 assertOwner(store, accountId);
 const id = bookmarkId(remote);
 return store.transaction('r', [store.bookmarks, store.outbox, store.bookmarkChoices], async () => {
  if (await store.bookmarkChoices.get(id)) throw new Error('Сначала заверши или отмени незавершённое сохранение этой закладки.');
  const operations = await store.outbox.where('entity').equals(`bookmark:${id}`).toArray();
  if (operations.some(op => op.state === 'sending')) throw new Error('Закладка отправляется. Дождись завершения и сравни заново.');
  return { accountId, remote, local: await store.bookmarks.get(id), operationIds: operations.map(op => op.id).sort() };
 });
}
export async function acceptBookmarkDownload(store: LocalDatabase, review: BookmarkDownload, content: BookContent) {
 assertOwner(store, review.accountId);
 if (!validReadingLocator(review.remote, content)) throw new Error('Закладка относится к другому изданию или недоступному фрагменту.');
 const id = bookmarkId(review.remote);
 return withBookmarkLock(store, id, () => navigator.locks.request(readingLockName(store.scope, review.remote.bookId), { mode: 'exclusive', ifAvailable: true }, async lock => {
  if (!lock) throw new Error('Сначала сохрани и закрой читалку этой книги во всех вкладках.');
  const session = await getSession();
  if (!session) throw new Error('Вход истёк. Войди снова и сравни закладки.');
  assertOwner(store, session.user.id);
  await store.transaction('rw', [store.bookmarks, store.outbox, store.bookmarkChoices], async () => {
   if (await store.bookmarkChoices.get(id)) throw new Error('Сначала заверши или отмени незавершённое сохранение этой закладки.');
   const current = await store.bookmarks.get(id);
   const operations = await store.outbox.where('entity').equals(`bookmark:${id}`).toArray();
   if (!!current !== !!review.local || current && review.local && (!sameBookmark(current, review.local) || current.updatedAt !== review.local.updatedAt) || JSON.stringify(operations.map(op => op.id).sort()) !== JSON.stringify(review.operationIds) || operations.some(op => op.scope !== store.scope || op.state !== 'pending')) throw new Error('Закладка на устройстве изменилась. Закрой сравнение и открой его заново.');
   if (review.remote.deleted) await store.bookmarks.delete(id);
   else await store.bookmarks.put({ ...bookmarkEntry(review.remote), id, updatedAt: new Date().toISOString() });
   // Receiving an explicitly chosen server snapshot creates no outgoing echo.
   // Only this bookmark's reviewed local changes are superseded atomically.
   await store.outbox.bulkDelete(review.operationIds);
  });
 }));
}
