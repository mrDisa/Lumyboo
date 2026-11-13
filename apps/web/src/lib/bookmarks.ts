import type { components, paths } from './api.generated';
import type { AccountSession } from './auth';
import { ApiError, requestJSON } from './api';
export type BookmarkEntry = components['schemas']['BookmarkEntry'];
export type AccountBookmarks = components['schemas']['AccountBookmarks'];
export type BookmarkState = components['schemas']['BookmarkState'];
export type BookmarkChange = Omit<paths['/bookmarks/apply']['post']['requestBody']['content']['application/json'], 'accountId'>;
type AccountBookmarkState = paths['/bookmarks/state']['get']['responses'][200]['content']['application/json'];
type BookmarkResult = paths['/bookmarks/apply']['post']['responses'][200]['content']['application/json'];
function owned<T extends { accountId: string }>(data: T, accountId: string): T {
 if (data.accountId !== accountId) throw new ApiError('Аккаунт изменился. Открой профиль заново.', 409, 'account_changed');
 return data;
}
export function sameBookmark(a: BookmarkEntry, b: BookmarkEntry) {
 return a.bookId === b.bookId && a.version === b.version && a.chapter === b.chapter && a.paragraph === b.paragraph && a.offset === b.offset && a.label === b.label;
}
export function loadAccountBookmarkState(accountId: string, signal?: AbortSignal) {
 return requestJSON<AccountBookmarkState>('/bookmarks/state', { signal }).then(data => owned(data, accountId));
}
export async function applyAccountBookmark(session: AccountSession, change: BookmarkChange) {
 return owned(await requestJSON<BookmarkResult>('/bookmarks/apply', {
  method: 'POST', headers: { 'X-CSRF-Token': session.csrfToken },
  body: JSON.stringify({ accountId: session.user.id, operationId: change.operationId, expectedRevision: change.expectedRevision, deleted: change.deleted, bookmark: bookmarkEntry(change.bookmark) }),
 }), session.user.id);
}
export function bookmarkEntry<T extends BookmarkEntry>({ bookId, version, chapter, paragraph, offset, label }: T): BookmarkEntry {
 return { bookId, version, chapter, paragraph, offset, label };
}
export function bookmarkKey(entry: BookmarkEntry) { return JSON.stringify([entry.bookId, entry.version, entry.paragraph]); }
export async function loadAccountBookmarks(accountId: string, signal?: AbortSignal) {
 return owned(await requestJSON<AccountBookmarks>('/bookmarks/', { signal }), accountId);
}
export async function importGuestBookmarks(session: AccountSession, bookmarks: BookmarkEntry[]) {
 return owned(await requestJSON<AccountBookmarks>('/bookmarks/import', {
  method: 'POST', headers: { 'X-CSRF-Token': session.csrfToken },
  body: JSON.stringify({ accountId: session.user.id, bookmarks }),
 }), session.user.id);
}
