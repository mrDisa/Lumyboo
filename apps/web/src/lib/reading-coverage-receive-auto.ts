import { getSession, type AccountSession } from './auth';
import type { BookContent } from './books';
import type { LocalDatabase } from './db';
import { startReadingAuto, type ReadingAutoState } from './reading-auto';
import { receiveReadingCoverage } from './reading-coverage-download';

// One additive receive per opening, foreground return or reconnection. Retry
// transient failures while mounted; success, including empty history, ends a run.
export function startReadingCoverageReceive(deps: {
 store: LocalDatabase; session: AccountSession; content: BookContent;
 online: () => boolean; publish: (state: ReadingAutoState) => void;
}) {
 if (deps.store.scope !== `account:${deps.session.user.id}`) throw new Error('Аккаунт изменился. Открой книгу заново.');
 const receiver = startReadingAuto({
  accountId: deps.session.user.id, online: deps.online, publish: deps.publish,
  hasWork: async () => true, verify: getSession,
  send: (session, signal) => receiveReadingCoverage(deps.store, session, deps.content, signal),
 }, {
  offline: 'Получим фрагменты книги из аккаунта при восстановлении сети.',
  saving: 'Получаем фрагменты книги из аккаунта…',
  signIn: 'Войди снова, чтобы получить фрагменты книги из аккаунта.',
  waiting: 'Фрагменты книги из аккаунта получены.',
  paused: 'Не удалось получить фрагменты книги из аккаунта.',
  manual: 'Повтори получение в профиле.',
  retry: 'Повторим получение фрагментов книги позже.',
 }, { once: true });
 return {
  ...receiver,
  reconnect() {
   // Refresh a completed run or wake an offline one. Both methods preserve
   // in-flight work, backoff, permanent stops and cleanup cancellation.
   receiver.refresh(); receiver.wake();
  },
 };
}
