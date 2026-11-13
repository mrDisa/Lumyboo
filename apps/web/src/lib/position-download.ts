import type { LocalDatabase, Position } from './db';
import { readingLocator, type AccountPosition } from './positions';
import { withPositionChoiceLock } from './position-choices';
import { readingLockName } from './reading-ownership';
import { validReadingLocator } from './account-reading';
import { getSession } from './auth';
import type { BookContent } from './books';

export interface PositionDownload {
 accountId: string;
 remote: AccountPosition;
 local?: Position;
 operationIds: string[];
}
function assertOwner(store: LocalDatabase, accountId: string) {
 if (store.scope !== `account:${accountId}`) throw new Error('Аккаунт изменился. Открой профиль заново.');
}
export async function reviewPositionDownload(store: LocalDatabase, accountId: string, remote: AccountPosition): Promise<PositionDownload> {
 assertOwner(store, accountId);
 return store.transaction('r', [store.positions, store.outbox, store.positionChoices], async () => {
  if (await store.positionChoices.get(remote.bookId)) throw new Error('Сначала заверши или отмени незавершённое сохранение места этой книги.');
  const operations = await store.outbox.where('entity').equals(`position:${remote.bookId}`).toArray();
  if (operations.some(op => op.state === 'sending')) throw new Error('Место отправляется. Дождись завершения и сравни заново.');
  return { accountId, remote, local: await store.positions.get(remote.bookId), operationIds: operations.map(op => op.id).sort() };
 });
}
export async function acceptPositionDownload(store: LocalDatabase, review: PositionDownload, content: BookContent) {
 assertOwner(store, review.accountId);
 if (!validReadingLocator(review.remote, content)) throw new Error('Место относится к другому изданию или недоступному фрагменту.');
 return withPositionChoiceLock(store, review.remote.bookId, () => navigator.locks.request(readingLockName(store.scope, review.remote.bookId), { mode: 'exclusive', ifAvailable: true }, async lock => {
  if (!lock) throw new Error('Сначала сохрани и закрой читалку этой книги во всех вкладках.');
  const session = await getSession();
  if (!session) throw new Error('Вход истёк. Войди снова и сравни места.');
  assertOwner(store, session.user.id);
  await store.transaction('rw', [store.positions, store.positionHistory, store.outbox, store.positionChoices], async () => {
   if (await store.positionChoices.get(review.remote.bookId)) throw new Error('Сначала заверши или отмени незавершённое сохранение места этой книги.');
   const current = await store.positions.get(review.remote.bookId);
   const operations = await store.outbox.where('entity').equals(`position:${review.remote.bookId}`).toArray();
   if (JSON.stringify(current) !== JSON.stringify(review.local) || JSON.stringify(operations.map(op => op.id).sort()) !== JSON.stringify(review.operationIds) || operations.some(op => op.scope !== store.scope || op.state !== 'pending')) throw new Error('Место на устройстве изменилось. Закрой сравнение и открой его заново.');
   if (current) await store.positionHistory.put({ ...current, id: `choice:${crypto.randomUUID()}` });
   await store.positions.put({ ...readingLocator(review.remote), updatedAt: new Date().toISOString() });
   // Receiving a chosen snapshot does not generate a new outgoing position.
   await store.outbox.bulkDelete(review.operationIds);
  });
 }));
}
