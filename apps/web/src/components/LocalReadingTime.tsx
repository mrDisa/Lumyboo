import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { db, type LocalDatabase } from '../lib/db';
import { accountDatabase } from '../lib/account-reading';
import { DailyGoalCard } from './DailyGoal';
import { useDailyGoal } from '../lib/use-daily-goal';
import { localDay } from '../lib/reading';
import { loadLocalReadingTime } from '../lib/local-reading-time';
import { LocalReadingDay } from './LocalReadingDay';
import { readingDuration } from '../lib/reading-session-history';

export function GuestReadingTime() {
 return <LocalReadingTime store={db} guest />;
}

export function AccountLocalReadingTime({ accountId }: { accountId: string }) {
 return <LocalReadingTime key={accountId} store={accountDatabase(accountId)} guest={false} />;
}

function LocalReadingTime({ store, guest }: { store: LocalDatabase; guest: boolean }) {
 const { goal } = useDailyGoal(store);
 const [day, setDay] = useState(localDay);
 const [attempt, setAttempt] = useState(0);
 const [selectedDay, setSelectedDay] = useState<string | null>(null);
 const [expanded, setExpanded] = useState(false);
 const [limit, setLimit] = useState(20);
 const [state, setState] = useState<{ value?: Awaited<ReturnType<typeof loadLocalReadingTime>>; error?: boolean }>({});
 useEffect(() => {
  const refresh = () => setDay(localDay(new Date(), goal?.timeZone));
  refresh();
  const interval = setInterval(refresh, 1000);
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', refresh);
  return () => { clearInterval(interval); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
 }, [goal?.timeZone]);
 useEffect(() => {
  setState({});
  const subscription = liveQuery(() => loadLocalReadingTime(store, day)).subscribe({
   next: value => setState({ value }), error: () => setState({ error: true }),
  });
  return () => subscription.unsubscribe();
 }, [store, day, attempt]);
 const historyId = guest ? 'guest-reading-days' : 'account-local-reading-days';
 return <section className="section" aria-label={guest ? 'Гостевое время чтения' : 'Время аккаунта на этом устройстве'}>
  <DailyGoalCard store={store} />
  {!guest && <h3>На этом устройстве</h3>}
  {state.error ? <p className="description" role="alert">Не удалось загрузить статистику. <button className="text-button" onClick={() => setAttempt(value => value + 1)}>Повторить</button></p> : !state.value ? <p className="description" role="status">Загружаем статистику…</p> : <>
   <div className={guest ? 'stats' : 'stats stats-time'}><div><b>{Math.floor(state.value.total / 60)}</b><small>минут за текстом</small></div><div><b>{Math.floor(state.value.today / 60)}</b><small>минут сегодня</small></div>{guest && <div><b>{state.value.bookmarks}</b><small>закладок</small></div>}</div>
   <button className="text-button section" aria-expanded={expanded} aria-controls={historyId} onClick={() => { setExpanded(!expanded); setLimit(20); }}>История чтения по дням</button>
   {expanded && <div id={historyId}>
    <p className="description section">{guest ? 'Сохранённое гостевое время' : 'Сохранённое время этого аккаунта'} за всеми книгами и изданиями на этом устройстве. Дни сохраняются в часовом поясе чтения; старые записи сохраняют исходную дату. Нажми на дату, чтобы увидеть книги.</p>
    {state.value.days.length ? <>
     <dl className="reading-days">{state.value.days.slice(0, limit).map(row => <div key={row.day}><dt><button className="text-button" aria-label={`Книги за ${row.day.split('-').reverse().join('.')}`} onClick={() => setSelectedDay(row.day)}><time dateTime={row.day}>{row.day.split('-').reverse().join('.')}</time></button></dt><dd>{readingDuration(Math.round(row.seconds * 1000))}</dd></div>)}</dl>
     {state.value.days.length > limit && <button className="text-button section" onClick={() => setLimit(value => value + 20)}>Показать ещё · осталось {state.value.days.length - limit}</button>}
    </> : <p className="description section">{guest ? 'Пока нет сохранённого гостевого времени. Открой книгу и начни читать.' : 'Пока нет сохранённого времени этого аккаунта на устройстве. Открой книгу из полки аккаунта и начни читать.'}</p>}
   </div>}
  </>}
  <p className="reader-note section">{guest ? 'Здесь только гостевое чтение на этом устройстве. Время аккаунта показано отдельно.' : 'Здесь только чтение этого аккаунта на устройстве, включая ещё не отправленное время. Гостевое время и серверная история сюда не прибавляются.'}</p>
  {selectedDay && <LocalReadingDay key={selectedDay} store={store} day={selectedDay} close={() => setSelectedDay(null)} />}
 </section>;
}
