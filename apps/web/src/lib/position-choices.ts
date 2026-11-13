import type { AccountSession } from './auth';
import type { LocalDatabase, SavedPositionChoice } from './db';
import { ApiError } from './api';
import { chooseAccountPosition } from './positions';

function assertOwner(store: LocalDatabase, accountId?: string) {
 if (!store.scope.startsWith('account:') || accountId && store.scope !== `account:${accountId}`) throw new Error('Аккаунт изменился. Открой профиль заново.');
}
// Persist the exact reviewed payload before any request. A second tab must
// resolve the existing operation rather than replace an uncertain request.
export async function rememberPositionChoice(store: LocalDatabase, value: SavedPositionChoice) {
 assertOwner(store);
 await store.transaction('rw', store.positionChoices, async () => {
  const existing = await store.positionChoices.get(value.bookId);
  if (existing && JSON.stringify(existing) !== JSON.stringify(value)) throw new Error('Для этой книги уже есть незавершённое сохранение. Открой его в профиле.');
  await store.positionChoices.put(value);
 });
}
export async function forgetPositionChoice(store: LocalDatabase, bookId: string, operationId: string) {
 assertOwner(store);
 await store.transaction('rw', store.positionChoices, async () => {
  if ((await store.positionChoices.get(bookId))?.choice.operationId === operationId) await store.positionChoices.delete(bookId);
 });
}
export async function sendPositionChoice(store: LocalDatabase, session: AccountSession, bookId: string, operationId: string) {
 assertOwner(store, session.user.id);
 const saved = await store.positionChoices.get(bookId);
 if (!saved || saved.choice.operationId !== operationId) throw new Error('Сохранённый выбор изменился. Открой его заново.');
 if (saved.conflict) throw new Error('Место аккаунта изменилось. Сравни места заново.');
 try {
  await chooseAccountPosition(session, saved.choice);
 } catch (error) {
  if (error instanceof ApiError && error.code === 'position_conflict') {
   await store.transaction('rw', store.positionChoices, async () => {
    if ((await store.positionChoices.get(bookId))?.choice.operationId === operationId) await store.positionChoices.update(bookId, { conflict: true });
   });
  }
  throw error;
 }
 // Do not clear newer reading/outbox changes: this receipt confirms only
 // the frozen choice, which can predate further reading on this device.
 await forgetPositionChoice(store, bookId, operationId);
}
