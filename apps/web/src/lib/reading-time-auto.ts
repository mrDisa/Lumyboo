import { startReadingAuto, type ReadingAutoDependencies } from './reading-auto';
export { ReadingAutoBusyError as ReadingTimeBusyError, type ReadingAutoState as ReadingTimeAutoState } from './reading-auto';

export function startReadingTimeAuto(deps: ReadingAutoDependencies) {
 return startReadingAuto(deps, {
  offline: 'Время остаётся на устройстве. Отправим при восстановлении сети.',
  saving: 'Сохраняем время в аккаунте…',
  signIn: 'Нужно снова войти в этот аккаунт, чтобы сохранить время.',
  waiting: 'Время чтения сохраняется автоматически, пока приложение открыто.',
  paused: 'Автосохранение времени остановлено.',
  manual: 'Попробуй сохранить время вручную.',
  retry: 'Не удалось сохранить время. Записи на устройстве; повторим отправку позже.',
 });
}
