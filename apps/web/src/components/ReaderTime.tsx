import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import type { LocalDatabase } from '../lib/db';
import { localDay } from '../lib/reading';
import { loadBookReadingTime } from '../lib/book-reading-time';
import styles from '../pages/Reader.module.css';
import { readingDuration } from '../lib/reading-session-history';

export function ReaderTime({ store, bookId, version }: { store: LocalDatabase; bookId: string; version: string }) {
 const [day, setDay] = useState(localDay);
 const [attempt, setAttempt] = useState(0);
 const [state, setState] = useState<{ value?: Awaited<ReturnType<typeof loadBookReadingTime>>; error?: boolean }>({});
 useEffect(() => {
  const refresh = () => setDay(localDay());
  const interval = setInterval(refresh, 1000);
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', refresh);
  return () => { clearInterval(interval); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
 }, []);
 useEffect(() => {
  setState({});
  const subscription = liveQuery(() => loadBookReadingTime(store, bookId, version, day)).subscribe({
   next: value => setState({ value }), error: () => setState({ error: true }),
  });
  return () => subscription.unsubscribe();
 }, [store, bookId, version, day, attempt]);
 return <>
  <p className="description">Время за текстом этого издания, сохранённое на этом устройстве {store.scope === 'guest' ? 'в гостевом режиме' : 'для текущего аккаунта'}.</p>
  {state.error ? <p className="description" role="alert">Не удалось загрузить время. <button className="text-button" onClick={() => setAttempt(value => value + 1)}>Повторить</button></p> : !state.value ? <p className="description" role="status">Загружаем время…</p> : <dl className={`section ${styles.timeSummary}`}>
   <dt>Сегодня</dt><dd>{state.value.today === 0 ? '0 с' : readingDuration(Math.round(state.value.today * 1000))}</dd>
   <dt>За всё время</dt><dd>{state.value.total === 0 ? '0 с' : readingDuration(Math.round(state.value.total * 1000))}</dd>
  </dl>}
  <p className="reader-note section">Сегодня — по дате устройства. Время из других изданий и с других устройств сюда не добавляется. Пока открыто это окно, чтение на паузе.</p>
 </>;
}
