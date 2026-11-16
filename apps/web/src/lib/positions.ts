import { randomId } from './random-id';
import type { components, paths } from './api.generated';
import type { AccountSession } from './auth';
import type { Position } from './db';
import { ApiError, requestJSON } from './api';
export type ReadingLocator = components['schemas']['ReadingLocator'];
export type AccountPosition = components['schemas']['AccountPosition'];
export type PositionChoice = components['schemas']['PositionChoice'];
export type AccountPositions = components['schemas']['AccountPositions'];
type ChoiceResult = paths['/positions/choose']['post']['responses'][200]['content']['application/json'];
function owned<T extends { accountId: string }>(data: T, accountId: string): T {
 if (data.accountId !== accountId) throw new ApiError('Аккаунт изменился. Открой профиль заново.', 409, 'account_changed');
 return data;
}
export function readingLocator({ bookId, version, chapter, paragraph, offset }: Position | ReadingLocator): ReadingLocator {
 return { bookId, version, chapter, paragraph, offset };
}
export function samePosition(a: ReadingLocator | undefined, b: ReadingLocator | undefined) {
 return !!a && !!b && a.bookId === b.bookId && a.version === b.version && a.chapter === b.chapter && a.paragraph === b.paragraph && a.offset === b.offset;
}
export function positionChoice(local: Position, remote?: AccountPosition): PositionChoice {
 return { operationId: randomId(), expectedRevision: remote?.revision ?? 0, position: readingLocator(local) };
}
export async function loadAccountPositions(accountId: string, signal?: AbortSignal) {
 return owned(await requestJSON<AccountPositions>('/positions/', { signal }), accountId);
}
export async function chooseAccountPosition(session: AccountSession, choice: PositionChoice) {
 return owned(await requestJSON<ChoiceResult>('/positions/choose', {
  method: 'POST', headers: { 'X-CSRF-Token': session.csrfToken },
  body: JSON.stringify({ accountId: session.user.id, ...choice }),
 }), session.user.id);
}
