import { getSession } from './auth';
import { validReadingLocator } from './account-reading';
import type { BookContent } from './books';
import type { LocalDatabase, SavedPositionChoice } from './db';
import { positionChoice, type AccountPosition } from './positions';
import { rememberPositionChoice, sendPositionChoice } from './position-choices';

// The revision was fetched before reading, never just before overwriting it.
// Each exit attempt keeps its exact operation across an uncertain response.
export function createReaderPositionSave(store: LocalDatabase, content: BookContent, remote?: AccountPosition) {
 let choice: SavedPositionChoice | undefined;
 return async () => {
  const session = await getSession();
  if (!session) throw new Error('Вход истёк. Место осталось на устройстве; войди снова для сохранения в аккаунте.');
  if (store.scope !== `account:${session.user.id}`) throw new Error('Аккаунт изменился. Место осталось в прежнем аккаунте на устройстве.');
  if (!choice) {
   if (await store.positionChoices.get(content.id)) throw new Error('Есть незавершённое сохранение этой книги. Проверь его в профиле.');
   const local = await store.positions.get(content.id);
   if (!local || !validReadingLocator(local, content)) throw new Error('Не удалось определить место текущего издания на устройстве.');
   choice = { bookId: content.id, conflict: false, choice: positionChoice(local, remote), remote };
  }
  await rememberPositionChoice(store, choice);
  await sendPositionChoice(store, session, content.id, choice.choice.operationId);
 };
}
