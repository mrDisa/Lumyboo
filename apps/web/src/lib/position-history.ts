import { savePosition, type LocalDatabase, type Position } from './db';
import { withPositionChoiceLock } from './position-choices';
import { readingLockName } from './reading-ownership';
import { validReadingLocator } from './account-reading';
import { getSession } from './auth';
import type { BookContent } from './books';

export type HistoricalPosition = Position & { id: string };
export interface PositionRestore {
 accountId: string;
 historical: HistoricalPosition;
 local?: Position;
 operationIds: string[];
}
async function localSnapshot(store: LocalDatabase, accountId: string, bookId: string) {
 if (store.scope !== `account:${accountId}`) throw new Error('Аккаунт изменился. Открой профиль заново.');
 if (await store.positionChoices.get(bookId)) throw new Error('Сначала заверши или отмени незавершённое сохранение места этой книги.');
 const operations = await store.outbox.where('entity').equals(`position:${bookId}`).toArray();
 if (operations.some(op => op.state !== 'pending' || op.scope !== store.scope)) throw new Error('Место отправляется. Дождись завершения и сравни заново.');
 return { local: await store.positions.get(bookId), operationIds: operations.map(op => op.id).sort() };
}
export async function reviewPositionRestore(store: LocalDatabase, accountId: string, id: string): Promise<PositionRestore> {
 // Read the archive and acknowledgement boundary in one consistent snapshot.
 return store.transaction('r', [store.positionHistory, store.positions, store.outbox, store.positionChoices], async () => {
  const historical = await store.positionHistory.get(id);
  if (!historical) throw new Error('Место больше недоступно в истории. Открой историю заново.');
  const review = await localSnapshot(store, accountId, historical.bookId);
  return { accountId, historical, local: review.local, operationIds: review.operationIds };
 });
}
export async function restoreHistoricalPosition(store: LocalDatabase, review: PositionRestore, content: BookContent) {
 if (store.scope !== `account:${review.accountId}`) throw new Error('Аккаунт изменился. Открой профиль заново.');
 if (!validReadingLocator(review.historical, content)) throw new Error('Место относится к другому изданию или недоступному фрагменту.');
 return withPositionChoiceLock(store, content.id, () => navigator.locks.request(readingLockName(store.scope, content.id), { mode: 'exclusive', ifAvailable: true }, async lock => {
  if (!lock) throw new Error('Сначала сохрани и закрой читалку этой книги во всех вкладках.');
  const session = await getSession();
  if (!session) throw new Error('Вход истёк. Войди снова и открой историю.');
  if (store.scope !== `account:${session.user.id}`) throw new Error('Аккаунт изменился. Открой профиль заново.');
  await store.transaction('rw', [store.positions, store.positionHistory, store.positionChoices, store.outbox, store.metadata], async () => {
   const historical = await store.positionHistory.get(review.historical.id);
   if (!historical || JSON.stringify(historical) !== JSON.stringify(review.historical)) throw new Error('История изменилась. Открой сравнение заново.');
   const current = await localSnapshot(store, review.accountId, historical.bookId);
   if (JSON.stringify(current.local) !== JSON.stringify(review.local) || JSON.stringify(current.operationIds) !== JSON.stringify(review.operationIds)) throw new Error('Место на устройстве изменилось. Открой сравнение заново.');
   // Keep the displaced variant; restoration is a new local edit, not a
   // server receipt. savePosition atomically queues it with a fresh UUID.
   if (current.local) await store.positionHistory.put({ ...current.local, id: `restore:${crypto.randomUUID()}` });
   const { id: _id, ...position } = historical;
   await savePosition({ ...position, updatedAt: new Date().toISOString() }, store);
  });
 }));
}
