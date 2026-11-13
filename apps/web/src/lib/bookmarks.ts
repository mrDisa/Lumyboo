import type { components } from './api.generated';
import type { AccountSession } from './auth';
import type { Bookmark } from './db';
import { ApiError, requestJSON } from './api';
export type BookmarkEntry = components['schemas']['BookmarkEntry'];
export type AccountBookmarks = components['schemas']['AccountBookmarks'];
function owned(data: AccountBookmarks, accountId: string) {
 if (data.accountId !== accountId) throw new ApiError('Аккаунт изменился. Открой профиль заново.', 409, 'account_changed');
 return data;
}
export function bookmarkEntry({ bookId, version, chapter, paragraph, offset, label }: Bookmark): BookmarkEntry {
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
