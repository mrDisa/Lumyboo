import { Link } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db';
import { useEffect, useSyncExternalStore } from 'react';
import { checkOfflineShell, getOfflineState, retryOfflineShell, subscribeOffline } from '../lib/pwa';
import { useApp } from '../lib/context';
import { Icon } from './ui';
export function OfflineStatus() {
  const state = useSyncExternalStore(subscribeOffline, getOfflineState);
  const { act } = useApp();
  const count = useLiveQuery(() => db.downloads.count(), [], 0);
  useEffect(() => { void checkOfflineShell(); }, []);
  const message = !state.supported ? 'В этом режиме браузера офлайн-запуск недоступен. Открой приложение в обычном браузере по HTTPS или на localhost.' : state.error ?? (state.shellReady ? 'Приложение сохранено на устройстве. Скачай нужные книги перед отключением сети.' : 'Подготавливаем приложение к запуску без сети. Дождись завершения перед отключением.');
  return <section className="offline-status section" aria-labelledby="offline-title">
    <div className="offline-status-heading"><Icon name={state.supported && state.shellReady && !state.error ? 'check' : 'books'} /><div><h3 id="offline-title">Чтение без сети</h3><p className="reader-note" role="status">{!state.supported ? 'Нужен защищённый адрес' : state.error ? 'Подготовка не завершена' : state.shellReady ? 'Приложение сохранено' : 'Подготавливаем приложение…'}</p></div></div>
    {state.supported && state.shellReady && !state.error ? <details className="goal-details"><summary>Как подготовиться</summary><p className="description">{message}</p></details> : <p className="description section" role="status">{message}</p>}
    {state.supported && (!state.shellReady || state.error) && <button className="secondary section" onClick={() => void act(retryOfflineShell)}>Повторить подготовку</button>}
    <Link className="secondary section" to="/downloads">Скачанные книги · {count}<Icon name="arrow" /></Link>
  </section>;
}
