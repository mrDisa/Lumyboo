import { randomId } from './random-id';
import { bookmarkEntry, bookmarkKey, type BookmarkEntry, type BookmarkState } from './bookmarks';

// A missing local bookmark is not evidence of deletion: the user must review
// the server locator explicitly. Never synthesize a locator from a delete key.
export function bookmarkReviews(local: BookmarkEntry[], remote: BookmarkState[]) {
 const keys = [...new Set([...local.map(bookmarkKey), ...remote.filter(entry => !entry.deleted).map(bookmarkKey)])];
 return keys.map(key => ({
  key,
  local: local.find(entry => bookmarkKey(entry) === key),
  remote: remote.find(entry => bookmarkKey(entry) === key),
 }));
}
export function reviewedBookmarkChange(local: BookmarkEntry | undefined, remote: BookmarkState | undefined, deleted: boolean) {
 const entry = deleted ? remote : local;
 if (!entry || deleted && remote?.deleted) throw new Error('Загрузи закладки и сравни варианты заново.');
 if (local && remote && bookmarkKey(local) !== bookmarkKey(remote)) throw new Error('Выбраны разные закладки.');
 return { operationId: randomId(), expectedRevision: remote?.revision ?? 0, bookmark: bookmarkEntry(entry), deleted };
}
