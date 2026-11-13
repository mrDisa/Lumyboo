import { startReadingAuto, type ReadingAutoDependencies } from './reading-auto';
import type { LocalDatabase } from './db';
import { readingCoverageReport } from './reading-coverage-sync';

export async function hasReadingCoverageWork(store: LocalDatabase) {
 if (!store.scope.startsWith('account:')) return false;
 return store.transaction('r', store.outbox, store.coverage, async () =>
  (await store.outbox.toArray()).some(op => op.scope === store.scope && !!readingCoverageReport(op)) ||
  (await store.coverage.toArray()).some(row => !row.queued));
}
export function startReadingCoverageAuto(deps: ReadingAutoDependencies) {
 return startReadingAuto(deps, {
  offline: 'Фрагменты остаются на устройстве. Отправим при восстановлении сети.',
  saving: 'Сохраняем фрагменты в аккаунте…',
  signIn: 'Нужно снова войти в этот аккаунт, чтобы сохранить фрагменты.',
  waiting: 'Фрагменты чтения сохраняются автоматически, пока приложение открыто.',
  paused: 'Автосохранение фрагментов остановлено.',
  manual: 'Попробуй сохранить фрагменты вручную.',
  retry: 'Не удалось сохранить фрагменты. Записи на устройстве; повторим отправку позже.',
 });
}
