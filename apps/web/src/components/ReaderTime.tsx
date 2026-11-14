import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import type { LocalDatabase } from '../lib/db';
import { useDailyGoal } from '../lib/use-daily-goal';
import { localDay } from '../lib/reading';
import { loadBookReadingTime } from '../lib/book-reading-time';
import styles from '../pages/Reader.module.css';
import { readingDuration } from '../lib/reading-session-history';

export function ReaderTime({ store, bookId, version }: { store: LocalDatabase; bookId: string; version: string }) {
 const { goal } = useDailyGoal(store);
 const [day, setDay] = useState(localDay);
 const [attempt, setAttempt] = useState(0);
 const [limit, setLimit] = useState(20);
 const [state, setState] = useState<{ value?: Awaited<ReturnType<typeof loadBookReadingTime>>; error?: boolean }>({});
 useEffect(() => {
  const refresh = () => setDay(localDay(new Date(), goal?.timeZone));
  refresh();
  const interval = setInterval(refresh, 1000);
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', refresh);
  return () => { clearInterval(interval); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
 }, [goal?.timeZone]);
 useEffect(() => { setLimit(20); }, [store, bookId, version]);
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
  {state.value && <section className="section" aria-label="Время по дням">
   <h3>По дням</h3>
   {state.value.days.length ? <>
    <dl className={styles.timeSummary}>{state.value.days.slice(0, limit).map(row => <div className={styles.timeDay} key={row.day}>
     <dt><time dateTime={row.day}>{row.day.split('-').reverse().join('.')}</time></dt><dd>{readingDuration(Math.round(row.seconds * 1000))}</dd>
    </div>)}</dl>
    {state.value.days.length > limit && <button className="text-button" onClick={() => setLimit(value => value + 20)}>Показать ещё · осталось {state.value.days.length - limit}</button>}
   </> : <p className="description">Пока нет сохранённого времени за этим изданием.</p>}
  </section>}
  <p className="reader-note section">Сегодня — по сохранённому часовому поясу чтения. Время из других изданий и с других устройств сюда не добавляется. Пока открыто это окно, чтение на паузе.</p>
 </>;
}
