import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import type { LocalDatabase } from '../lib/db';
import { useDailyGoal } from '../lib/use-daily-goal';
import { localDay } from '../lib/reading';
import { loadBookReadingTime } from '../lib/book-reading-time';
import styles from '../pages/Reader.module.css';
import { Icon } from './ui';
import { readingDuration } from '../lib/reading-session-history';

export function ReaderTime({ store, bookId, version }: { store: LocalDatabase; bookId: string; version: string }) {
 const { goal } = useDailyGoal(store);
 const [day, setDay] = useState(localDay);
 const [attempt, setAttempt] = useState(0);
 const [limit, setLimit] = useState(7);
 const [state, setState] = useState<{ value?: Awaited<ReturnType<typeof loadBookReadingTime>>; error?: boolean }>({});
 useEffect(() => {
  const refresh = () => setDay(localDay(new Date(), goal?.timeZone));
  refresh();
  const interval = setInterval(refresh, 1000);
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', refresh);
  return () => { clearInterval(interval); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
 }, [goal?.timeZone]);
 useEffect(() => { setLimit(7); }, [store, bookId, version]);
 useEffect(() => {
  setState({});
  const subscription = liveQuery(() => loadBookReadingTime(store, bookId, version, day)).subscribe({
   next: value => setState({ value }), error: () => setState({ error: true }),
  });
  return () => subscription.unsubscribe();
 }, [store, bookId, version, day, attempt]);
 const duration = (seconds: number) => seconds === 0 ? '0 с' : readingDuration(Math.round(seconds * 1000));
 const longestDay = Math.max(1, ...state.value?.days.map(row => row.seconds) ?? []);
 return <div className={styles.bookTime}>
  <div className={styles.timeScope}><Icon name="clock" /><span>Это издание · на устройстве</span><span>На паузе</span></div>
  {state.error ? <p className="description" role="alert">Не удалось загрузить время. <button className="text-button" onClick={() => setAttempt(value => value + 1)}>Повторить</button></p> : !state.value ? <p className="description" role="status">Загружаем время…</p> : <>
   <dl className={styles.timeTotals}>
    <div className={styles.timeToday}><dt>Сегодня за книгой</dt><dd>{duration(state.value.today)}</dd><time dateTime={day}>{day.split('-').reverse().join('.')}</time></div>
    <div className={styles.timeAll}><dt>За всё время</dt><dd>{duration(state.value.total)}</dd></div>
   </dl>
   {state.value.days.length ? <section aria-label="Время по дням">
    <div className={styles.contentsIntro}><h3>Дни чтения</h3><span>{state.value.days.length}</span></div>
    <p className={styles.timeCaption}>Длина полосы — относительно самого долгого дня</p>
    <ol className={styles.timeDays}>{state.value.days.slice(0, limit).map(row => <li key={row.day}>
     <div><time dateTime={row.day}>{row.day === day ? 'Сегодня' : row.day.split('-').reverse().join('.')}</time><b>{duration(row.seconds)}</b></div>
     <span className={styles.timeTrack} aria-hidden="true"><span style={{ width: `${row.seconds / longestDay * 100}%` }} /></span>
    </li>)}</ol>
    {state.value.days.length > limit && <button className="text-button section" onClick={() => setLimit(value => value + 7)}>Показать ещё · осталось {state.value.days.length - limit}</button>}
   </section> : <div className={styles.timeEmpty}><Icon name="clock" /><b>Время для первой страницы</b><span>Вернись к тексту — здесь появится время чтения этой книги.</span></div>}
  </>}
  <details className={styles.coverageHelp}><summary>Как учитывается время</summary>
   <p className="description">Сохранённое время за текстом этого издания на этом устройстве {store.scope === 'guest' ? 'в гостевом режиме' : 'для текущего аккаунта'}. Время других изданий и устройств сюда не добавляется.</p>
   <p className="description">Сегодня — по сохранённому часовому поясу чтения. Пока открыто это окно, чтение на паузе.</p>
  </details>
 </div>;
}
