import type { components } from './api.generated';
import type { AccountSession } from './auth';
import { ApiError, requestJSON } from './api';
export type AccountShelf = components['schemas']['AccountShelf'];
function owned(shelf: AccountShelf, accountId: string) {
 if (shelf.accountId !== accountId) throw new ApiError('Аккаунт изменился. Открой профиль заново.', 409, 'account_changed');
 return shelf;
}
export async function loadAccountShelf(accountId: string, signal?: AbortSignal) {
 return owned(await requestJSON<AccountShelf>('/shelf/', { signal }), accountId);
}
export async function importGuestShelf(session: AccountSession, bookIds: string[]) {
 return owned(await requestJSON<AccountShelf>('/shelf/import', {
  method: 'POST', headers: { 'X-CSRF-Token': session.csrfToken },
  body: JSON.stringify({ accountId: session.user.id, bookIds }),
 }), session.user.id);
}
