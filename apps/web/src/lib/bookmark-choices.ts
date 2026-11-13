import type { AccountSession } from './auth';
import { ApiError } from './api';
import { bookmarkId, type LocalDatabase } from './db';
import { applyAccountBookmark, bookmarkEntry, sameBookmark, type BookmarkChange } from './bookmarks';

function assertOwner(store: LocalDatabase, accountId?: string) {
 if (!store.scope.startsWith('account:') || accountId && store.scope !== `account:${accountId}`) throw new Error('Аккаунт изменился. Открой профиль заново.');
}
async function withBookmarkLock<T>(store: LocalDatabase, id: string, action: () => Promise<T>): Promise<T> {
 if (!navigator.locks) throw new Error('Для безопасного сохранения закладки открой приложение в обновлённом браузере по HTTPS или на localhost.');
 return navigator.locks.request(`lumyboo-bookmark-choice:${JSON.stringify([store.scope, id])}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
  if (!lock) throw new Error('Закладка сохраняется в другой вкладке. Дождись завершения и повтори действие.');
  return action();
 });
}
function canonical(change: BookmarkChange): BookmarkChange {
 return { operationId: change.operationId, expectedRevision: change.expectedRevision, bookmark: bookmarkEntry(change.bookmark), deleted: change.deleted };
}
// This is an explicit reviewed change, not an automatic conversion of outbox
// entries. In particular, deletion needs the reviewed server/local locator:
// legacy delete entries contain only a key and cannot supply a safe payload.
export async function rememberBookmarkChoice(store: LocalDatabase, input: BookmarkChange) {
 assertOwner(store);
 const change = canonical(input);
 const id = bookmarkId(change.bookmark);
 return withBookmarkLock(store, id, () => store.transaction('rw', [store.bookmarkChoices, store.outbox], async () => {
  const existing = await store.bookmarkChoices.get(id);
  if (existing) {
   if (JSON.stringify(existing.change) !== JSON.stringify(change)) throw new Error('Для этой закладки уже есть незавершённое сохранение. Сначала заверши его.');
   return; // Never widen the original acknowledgement boundary on retry.
  }
  const operations = await store.outbox.toArray();
  const coveredOperationIds = operations.filter(op => op.scope === store.scope && op.change.key === id && (
   change.deleted ? op.change.type === 'bookmark.delete' : op.change.type === 'bookmark.put' && sameBookmark(op.change.value, change.bookmark)
  )).map(op => op.id);
  await store.bookmarkChoices.add({ id, change, conflict: false, coveredOperationIds });
 }));
}
// Cancellation leaves local data/outbox untouched and cannot undo a request
// which the server may already have committed. Any new choice needs a refetch.
export async function forgetBookmarkChoice(store: LocalDatabase, id: string, operationId: string) {
 assertOwner(store);
 return withBookmarkLock(store, id, () => store.transaction('rw', store.bookmarkChoices, async () => {
  if ((await store.bookmarkChoices.get(id))?.change.operationId === operationId) await store.bookmarkChoices.delete(id);
 }));
}
export async function sendBookmarkChoice(store: LocalDatabase, session: AccountSession, id: string, operationId: string) {
 assertOwner(store, session.user.id);
 return withBookmarkLock(store, id, async () => {
  const saved = await store.bookmarkChoices.get(id);
  if (!saved || saved.change.operationId !== operationId) throw new Error('Сохранённое изменение закладки изменилось. Открой его заново.');
  if (saved.conflict) throw new Error('Закладка аккаунта изменилась. Сравни варианты заново.');
  try {
   const { bookmark } = await applyAccountBookmark(session, saved.change);
   if (!bookmark || !sameBookmark(bookmark, saved.change.bookmark) || bookmark.deleted !== saved.change.deleted || !Number.isSafeInteger(bookmark.revision) || bookmark.revision !== saved.change.expectedRevision + 1) throw new Error('Сервер не подтвердил изменение закладки. Сохранение можно повторить.');
  } catch (error) {
   if (error instanceof ApiError && error.code === 'bookmark_conflict') await store.bookmarkChoices.update(id, { conflict: true });
   throw error;
  }
  await store.transaction('rw', [store.bookmarkChoices, store.outbox], async () => {
   if ((await store.bookmarkChoices.get(id))?.change.operationId !== operationId) return;
   for (const opId of saved.coveredOperationIds) {
    const op = await store.outbox.get(opId);
    if (op?.scope === store.scope && op.change.key === id && (saved.change.deleted ? op.change.type === 'bookmark.delete' : op.change.type === 'bookmark.put' && sameBookmark(op.change.value, saved.change.bookmark))) await store.outbox.delete(opId);
   }
   // A receipt confirms this mutation, not current server state. Do not apply
   // its locator to bookmarks: later edits and remote changes may exist.
   await store.bookmarkChoices.delete(id);
  });
 });
}
