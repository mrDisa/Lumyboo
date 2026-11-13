import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { db } from '../lib/db';
import { localDay } from '../lib/reading';
import { loadLocalReadingTime } from '../lib/local-reading-time';
import { readingDuration } from '../lib/reading-session-history';

export function GuestReadingTime() {
 const [day, setDay] = useState(localDay);
 const [attempt, setAttempt] = useState(0);
 const [expanded, setExpanded] = useState(false);
 const [limit, setLimit] = useState(20);
 const [state, setState] = useState<{ value?: Awaited<ReturnType<typeof loadLocalReadingTime>>; error?: boolean }>({});
 useEffect(() => {
  const refresh = () => setDay(localDay());
  const interval = setInterval(refresh, 1000);
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', refresh);
  return () => { clearInterval(interval); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
 }, []);
 useEffect(() => {
  setState({});
  const subscription = liveQuery(() => loadLocalReadingTime(db, day)).subscribe({
   next: value => setState({ value }), error: () => setState({ error: true }),
  });
  return () => subscription.unsubscribe();
 }, [day, attempt]);
 return <section className="section" aria-label="Гостевое время чтения">
  {state.error ? <p className="description" role="alert">Не удалось загрузить статистику. <button className="text-button" onClick={() => setAttempt(value => value + 1)}>Повторить</button></p> : !state.value ? <p className="description" role="status">Загружаем статистику…</p> : <>
   <div className="stats"><div><b>{Math.floor(state.value.total / 60)}</b><small>минут за текстом</small></div><div><b>{Math.floor(state.value.today / 60)}</b><small>минут сегодня</small></div><div><b>{state.value.bookmarks}</b><small>закладок</small></div></div>
   <button className="text-button section" aria-expanded={expanded} aria-controls="guest-reading-days" onClick={() => { setExpanded(!expanded); setLimit(20); }}>История чтения по дням</button>
   {expanded && <div id="guest-reading-days">
    <p className="description section">Сохранённое гостевое время за всеми книгами и изданиями на этом устройстве. Дни указаны по часам устройства.</p>
    {state.value.days.length ? <>
     <dl className="reading-days">{state.value.days.slice(0, limit).map(row => <div key={row.day}><dt><time dateTime={row.day}>{row.day.split('-').reverse().join('.')}</time></dt><dd>{readingDuration(Math.round(row.seconds * 1000))}</dd></div>)}</dl>
     {state.value.days.length > limit && <button className="text-button section" onClick={() => setLimit(value => value + 20)}>Показать ещё · осталось {state.value.days.length - limit}</button>}
    </> : <p className="description section">Пока нет сохранённого гостевого времени. Открой книгу и начни читать.</p>}
   </div>}
  </>}
  <p className="reader-note section">Здесь только гостевое чтение на этом устройстве. Время аккаунта показано отдельно.</p>
 </section>;
}
