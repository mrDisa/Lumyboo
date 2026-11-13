import { Link } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../lib/db';
import { useEffect, useSyncExternalStore } from 'react';
import { checkOfflineShell, getOfflineState, retryOfflineShell, subscribeOffline } from '../lib/pwa';
import { useApp } from '../lib/context';
export function OfflineStatus() {
  const state = useSyncExternalStore(subscribeOffline, getOfflineState);
  const { act } = useApp();
  const count = useLiveQuery(() => db.downloads.count(), [], 0);
  useEffect(() => { void checkOfflineShell(); }, []);
  return <section className="offline-status section" aria-labelledby="offline-title"><h3 id="offline-title">Чтение без сети</h3><p className="description" role="status">{!state.supported ? 'В этом режиме браузера офлайн-запуск недоступен. Открой приложение в обычном браузере по HTTPS или на localhost.' : state.error ?? (state.shellReady ? 'Приложение сохранено на устройстве. Скачай нужные книги перед отключением сети.' : 'Подготавливаем приложение к запуску без сети. Дождись завершения перед отключением.')}</p>{state.supported && !state.shellReady && <button className="secondary" onClick={() => void act(retryOfflineShell)}>Повторить подготовку</button>}<Link className="secondary section" to="/downloads">Скачанные книги · {count}</Link></section>;
}
