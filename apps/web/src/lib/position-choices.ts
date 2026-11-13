import type { AccountSession } from './auth';
import type { LocalDatabase, SavedPositionChoice } from './db';
import { ApiError } from './api';
import { chooseAccountPosition, samePosition } from './positions';

function assertOwner(store: LocalDatabase, accountId?: string) {
 if (!store.scope.startsWith('account:') || accountId && store.scope !== `account:${accountId}`) throw new Error('Аккаунт изменился. Открой профиль заново.');
}
// Keep the reviewed choice present until the request and local receipt finish.
// Otherwise another tab could cancel it mid-request and adopt an older server
// position while the first tab is still changing that same server position.
export async function withPositionChoiceLock<T>(store: LocalDatabase, bookId: string, action: () => Promise<T>): Promise<T> {
 if (!navigator.locks) throw new Error('Для безопасного сохранения места открой приложение в обновлённом браузере по HTTPS или на localhost.');
 const name = `lumyboo-position-choice:${JSON.stringify([store.scope, bookId])}`;
 return navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, async lock => {
  if (!lock) throw new Error('Место этой книги сохраняется в другой вкладке. Дождись завершения и повтори действие.');
  return action();
 });
}
// Persist the exact reviewed payload before any request. A second tab must
// resolve the existing operation rather than replace an uncertain request.
export async function rememberPositionChoice(store: LocalDatabase, value: SavedPositionChoice) {
 assertOwner(store);
 return withPositionChoiceLock(store, value.bookId, async () => {
  await store.transaction('rw', [store.positionChoices, store.outbox], async () => {
   const existing = await store.positionChoices.get(value.bookId);
   if (existing) {
    if (JSON.stringify(existing.choice) !== JSON.stringify(value.choice) || JSON.stringify(existing.remote) !== JSON.stringify(value.remote) || existing.conflict !== value.conflict) throw new Error('Для этой книги уже есть незавершённое сохранение. Открой его в профиле.');
    return; // A retry must keep the original acknowledgement boundary.
   }
   const operations = await store.outbox.toArray();
   const coveredPositionOperationIds = operations.filter(op => op.scope === store.scope && op.change?.type === 'position.put' && samePosition(op.change.value, value.choice.position)).map(op => op.id);
   const { coveredPositionOperationIds: _ignored, ...reviewed } = value;
   await store.positionChoices.put(coveredPositionOperationIds.length ? { ...reviewed, coveredPositionOperationIds } : reviewed);
  });
 });
}
export async function forgetPositionChoice(store: LocalDatabase, bookId: string, operationId: string) {
 assertOwner(store);
 return withPositionChoiceLock(store, bookId, async () => {
  await store.transaction('rw', store.positionChoices, async () => {
   if ((await store.positionChoices.get(bookId))?.choice.operationId === operationId) await store.positionChoices.delete(bookId);
  });
 });
}
export async function sendPositionChoice(store: LocalDatabase, session: AccountSession, bookId: string, operationId: string) {
 assertOwner(store, session.user.id);
 return withPositionChoiceLock(store, bookId, async () => {
  const saved = await store.positionChoices.get(bookId);
  if (!saved || saved.choice.operationId !== operationId) throw new Error('Сохранённый выбор изменился. Открой его заново.');
  if (saved.conflict) throw new Error('Место аккаунта изменилось. Сравни места заново.');
  try {
   const result = await chooseAccountPosition(session, saved.choice);
   if (!samePosition(result.position, saved.choice.position) || !Number.isSafeInteger(result.position.revision) || result.position.revision <= 0) throw new Error('Сервер не подтвердил выбранное место. Сохранение можно повторить.');
  } catch (error) {
   if (error instanceof ApiError && error.code === 'position_conflict') {
    await store.transaction('rw', store.positionChoices, async () => {
     if ((await store.positionChoices.get(bookId))?.choice.operationId === operationId) await store.positionChoices.update(bookId, { conflict: true });
    });
   }
   throw error;
  }
  // Delete only snapshots captured before the first request, atomically with
  // the choice. Never infer acknowledgement from today's local locator.
  await store.transaction('rw', [store.positionChoices, store.outbox], async () => {
   if ((await store.positionChoices.get(bookId))?.choice.operationId !== operationId) return;
   for (const id of saved.coveredPositionOperationIds ?? []) {
    const op = await store.outbox.get(id);
    if (op?.scope === store.scope && op.change.type === 'position.put' && samePosition(op.change.value, saved.choice.position)) await store.outbox.delete(id);
   }
   await store.positionChoices.delete(bookId);
  });
 });
}
