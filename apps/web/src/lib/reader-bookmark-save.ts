import { getSession } from './auth';
import { validReadingLocator } from './account-reading';
import type { BookContent } from './books';
import { bookmarkEntry, type BookmarkChange, type BookmarkState } from './bookmarks';
import { rememberBookmarkChoice, sendBookmarkChoice } from './bookmark-choices';
import { bookmarkId, type LocalDatabase } from './db';

// Capture the complete revision snapshot and local dirty keys before reading.
// Older edits need review; fetching a new revision at exit could overwrite a
// concurrent change. Deletions use an actual opening locator, never a key.
export async function createReaderBookmarkSave(store: LocalDatabase, content: BookContent, remote: BookmarkState[]) {
 const opening = await store.transaction('r', [store.bookmarks, store.outbox], async () => ({
  local: await store.bookmarks.where('bookId').equals(content.id).filter(b => b.version === content.version).toArray(),
  dirty: new Set((await store.outbox.toArray()).filter(op => op.scope === store.scope && op.entity.startsWith('bookmark:')).map(op => op.change.key)),
 }));
 const known = new Map(remote.filter(b => validReadingLocator(b, content)).map(b => [bookmarkId(b), b]));
 const ids = new Set(content.chapters.flatMap(c => c.paragraphs.map(p => bookmarkId({ bookId: content.id, version: content.version, paragraph: p.id }))));
 let changes: BookmarkChange[] | undefined;
 const completed = new Set<string>();
 return async () => {
  const session = await getSession();
  if (!session) throw new Error('Вход истёк. Закладки остались на устройстве; войди снова для сохранения в аккаунте.');
  if (store.scope !== `account:${session.user.id}`) throw new Error('Аккаунт изменился. Закладки остались в прежнем аккаунте на устройстве.');
  if (!changes) {
   changes = await store.transaction('rw', [store.bookmarks, store.outbox, store.bookmarkChoices], async () => {
    const operations = (await store.outbox.toArray()).filter(op => op.scope === store.scope && ids.has(op.change.key) && (op.change.type === 'bookmark.put' || op.change.type === 'bookmark.delete')).sort((a, b) => a.sequence - b.sequence);
    const result: BookmarkChange[] = [];
    for (const op of operations) {
     const id = op.change.key;
     if (opening.dirty.has(id) || await store.bookmarkChoices.get(id) || op.state !== 'pending') throw new Error('Есть прежнее незавершённое изменение закладки. Сравни варианты в профиле.');
     const local = await store.bookmarks.get(id);
     const previous = known.get(id);
     const deleted = op.change.type === 'bookmark.delete';
     const entry = deleted ? opening.local.find(b => b.id === id) ?? previous : local;
     if (deleted && !entry) {
      // Created and removed during this reading; no server bookmark was seen.
      // Drop only this exact operation while holding the write transaction.
      await store.outbox.delete(op.id);
      continue;
     }
     if (!entry || !validReadingLocator(entry, content)) throw new Error('Не удалось определить закладку текущего издания. Сравни варианты в профиле.');
     result.push({ operationId: crypto.randomUUID(), expectedRevision: previous?.revision ?? 0, bookmark: bookmarkEntry(entry), deleted });
    }
    return result;
   });
  }
  for (const change of changes) {
   if (completed.has(change.operationId)) continue;
   await rememberBookmarkChoice(store, change);
   await sendBookmarkChoice(store, session, bookmarkId(change.bookmark), change.operationId);
   completed.add(change.operationId);
  }
 };
}
