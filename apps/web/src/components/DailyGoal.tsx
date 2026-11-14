import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { LocalDatabase } from '../lib/db';
import { chooseDailyGoal, goalDay, goalMinutes, goalOptions, loadDailyProgress, nextGoalDay } from '../lib/daily-goal';
import { useDailyGoal } from '../lib/use-daily-goal';
import { useApp } from '../lib/context';
import { readingDuration } from '../lib/reading-session-history';

export function DailyGoalCard({ store }: { store: LocalDatabase }) {
 const { goal, error, retry } = useDailyGoal(store);
 const { act } = useApp();
 const [now, setNow] = useState(() => new Date());
 const [editing, setEditing] = useState(false);
 const [busy, setBusy] = useState(false);
 useEffect(() => {
  const refresh = () => setNow(new Date());
  const timer = setInterval(refresh, 1000);
  window.addEventListener('focus', refresh);
  return () => { clearInterval(timer); window.removeEventListener('focus', refresh); };
 }, []);
 const day = goal ? goalDay(goal.timeZone, now) : '';
 const progress = useLiveQuery(async () => {
  if (!goal) return undefined;
  try { return await loadDailyProgress(store, goal, day); }
  catch { return null; }
 }, [store, goal, day, error]);
 const tomorrow = goal && goalMinutes(goal, nextGoalDay(day));
 async function choose(minutes: number) {
  setBusy(true);
  try { await act(() => chooseDailyGoal(store, minutes), 'Цель на завтра сохранена'); }
  finally { setBusy(false); }
 }
 return <section className="daily-goal section" aria-label={store.scope === 'guest' ? 'Дневная цель гостя' : 'Дневная цель аккаунта'}>
  <span className="eyebrow">{store.scope === 'guest' ? 'Твой день · гость' : 'Твой день · аккаунт'}</span>
  {error ? <p role="alert">Не удалось загрузить цель. <button className="text-button" onClick={retry}>Повторить</button></p> : !goal || progress === undefined ? <p role="status">Загружаем цель…</p> : progress === null ? <p role="alert">Не удалось загрузить время. <button className="text-button" onClick={retry}>Повторить</button></p> : <>
   <h3 className="section">{progress.complete ? 'Цель на сегодня выполнена.' : `${progress.minutes} минут для себя.`}</h3>
   <p className="description section">{Math.floor(progress.seconds / 60)} из {progress.minutes} мин{!progress.complete && <> · осталось {readingDuration(progress.remaining * 1000)}</>}</p>
   <progress className="goal-progress" aria-label="Прогресс дневной цели" max={progress.minutes * 60} value={Math.min(progress.seconds, progress.minutes * 60)} />
   <p className="reader-note">{day.split('-').reverse().join('.')} · {goal.timeZone}</p>
   {tomorrow !== progress.minutes && <p className="description section">С завтрашнего дня — {tomorrow} мин.</p>}
   <button className="text-button section" aria-expanded={editing} onClick={() => setEditing(!editing)}>Изменить цель</button>
   {editing && <><p className="description section">Новая цель действует с завтрашнего дня. Сегодняшний план и прошлые дни сохраняются.</p><div className="choice-row goal-options" aria-label="Цель на завтра">{goalOptions.map(minutes => <button className={`pill ${tomorrow === minutes ? 'active' : ''}`} aria-pressed={tomorrow === minutes} key={minutes} disabled={busy} onClick={() => void choose(minutes)}>{minutes} мин</button>)}</div></>}
   <p className="reader-note section">Цель и результат на этом устройстве. {store.scope === 'guest' ? 'Учитывается только гостевое чтение.' : 'Предварительный результат: только чтение этого аккаунта на устройстве. Цель пока не переносится на другие устройства.'}</p>
  </>}
 </section>;
}
