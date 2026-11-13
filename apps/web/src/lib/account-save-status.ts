import type { LocalDatabase } from './db';

// Read both queues in one snapshot. An empty queue is not proof that this
// device has fetched the latest server state.
export async function accountSaveStatus(store: LocalDatabase) {
 if (store.scope === 'guest') throw new Error('Нужно войти в аккаунт.');
 return store.transaction('r', [store.outbox, store.positionChoices], async () => {
  const operations = await store.outbox.toArray();
  const choices = await store.positionChoices.toArray();
  return {
   positions: operations.filter(op => op.change.type === 'position.put').length,
   bookmarks: operations.filter(op => op.change.type.startsWith('bookmark.')).length,
   sessions: operations.filter(op => op.change.type === 'session.put').length,
   other: operations.filter(op => !['position.put', 'bookmark.put', 'bookmark.delete', 'session.put'].includes(op.change.type)).length,
   total: operations.length,
   choices: choices.length,
   conflicts: choices.filter(choice => choice.conflict).length,
  };
 });
}
export function accountSaveHeading(status: Awaited<ReturnType<typeof accountSaveStatus>>) {
 if (status.conflicts) return 'Есть конфликт мест чтения';
 if (status.choices) return 'Сохранение места не подтверждено';
 if (status.total) return 'Сохранено на устройстве';
 return 'Нет изменений, ожидающих отправки';
}
