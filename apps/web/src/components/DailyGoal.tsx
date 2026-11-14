import { GuestGoalImport } from './GuestGoalImport';
import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { LocalDatabase } from '../lib/db';
import { chooseDailyGoal, goalDay, goalMinutes, goalOptions, loadDailyProgress, nextGoalDay } from '../lib/daily-goal';
import { useDailyGoal } from '../lib/use-daily-goal';
import { useApp } from '../lib/context';
import { syncAccountGoal, type GoalSnapshot } from '../lib/account-daily-goal';
import { readingDuration } from '../lib/reading-session-history';

export function DailyGoalCard({ store }: { store: LocalDatabase }) {
 const { goal, error, retry } = useDailyGoal(store);
 const { act } = useApp();
 const [now, setNow] = useState(() => new Date());
 const [editing, setEditing] = useState(false);
 const [busy, setBusy] = useState(false);
 const [confirmed, setConfirmed] = useState<GoalSnapshot>();
 const [remoteError, setRemoteError] = useState('');
 const [refresh, setRefresh] = useState(0);
 const pendingCount = useLiveQuery(() => store.outbox.count(), [store]);
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
 useEffect(() => {
  if (store.scope === 'guest') return;
  let disposed = false;
  setConfirmed(undefined);
  void syncAccountGoal(store).then(value => { if (!disposed) { setConfirmed(value); setRemoteError(''); } }).catch(error => { if (!disposed) setRemoteError(error instanceof Error ? error.message : 'Не удалось обновить цель аккаунта.'); });
  return () => { disposed = true; };
 }, [store, day, pendingCount, refresh]);
 useEffect(() => {
  const update = () => setRefresh(value => value + 1);
  window.addEventListener('online', update); window.addEventListener('focus', update);
  return () => { window.removeEventListener('online', update); window.removeEventListener('focus', update); };
 }, []);
 const accepted = confirmed?.progress.day === day ? confirmed.progress : undefined;
 const tomorrow = goal && goalMinutes(goal, nextGoalDay(day));
 async function choose(minutes: number) {
  setBusy(true);
  try {
   await act(async () => {
    if (store.scope === 'guest') await chooseDailyGoal(store, minutes);
    else { const result = await syncAccountGoal(store, minutes); setConfirmed(result); setRemoteError(''); }
   }, 'Цель на завтра сохранена');
  }
  finally { setBusy(false); }
 }
 return <section className="daily-goal section" aria-label={store.scope === 'guest' ? 'Дневная цель гостя' : 'Дневная цель аккаунта'}>
  <span className="eyebrow">{store.scope === 'guest' ? 'Твой день · гость' : 'Твой день · аккаунт'}</span>
  {error ? <p role="alert">Не удалось загрузить цель. <button className="text-button" onClick={retry}>Повторить</button></p> : !goal || progress === undefined ? <p role="status">Загружаем цель…</p> : progress === null ? <p role="alert">Не удалось загрузить время. <button className="text-button" onClick={retry}>Повторить</button></p> : <>
   <h3 className="section">{(accepted?.complete ?? progress.complete) ? 'Цель на сегодня выполнена.' : `${progress.minutes} минут для себя.`}</h3>
   <p className="description section">{Math.floor((accepted ? accepted.milliseconds / 1000 : progress.seconds) / 60)} из {progress.minutes} мин{!(accepted?.complete ?? progress.complete) && <> · осталось {readingDuration(accepted ? Math.max(0, progress.minutes * 60000 - accepted.milliseconds) : progress.remaining * 1000)}</>}</p>
   <progress className="goal-progress" aria-label="Прогресс дневной цели" max={progress.minutes * 60} value={Math.min(accepted ? accepted.milliseconds / 1000 : progress.seconds, progress.minutes * 60)} />
   <p className="description section">Дней подряд: {accepted?.streak ?? progress.streak}</p>
   <p className="reader-note">Выполняй цель каждый день, чтобы продолжать серию. Пропущенный день сбрасывает её; сегодня ещё можно успеть.</p>
   <p className="reader-note">{day.split('-').reverse().join('.')} · {goal.timeZone}</p>
   {tomorrow !== progress.minutes && <p className="description section">С завтрашнего дня — {tomorrow} мин.</p>}
   <button className="text-button section" aria-expanded={editing} onClick={() => setEditing(!editing)}>Изменить цель</button>
   {editing && <><p className="description section">Новая цель действует с завтрашнего дня. Сегодняшний план и прошлые дни сохраняются.</p><div className="choice-row goal-options" aria-label="Цель на завтра">{goalOptions.map(minutes => <button className={`pill ${tomorrow === minutes ? 'active' : ''}`} aria-pressed={tomorrow === minutes} key={minutes} disabled={busy} onClick={() => void choose(minutes)}>{minutes} мин</button>)}</div></>}
   <p className="reader-note section">{store.scope === 'guest' ? 'Цель и результат на этом устройстве. Учитывается только гостевое чтение.' : accepted ? 'Подтверждено аккаунтом · время с подключённых устройств на момент обновления.' : 'Предварительный результат: чтение этого аккаунта на устройстве.'}</p>
   {store.scope !== 'guest' && <><p className="reader-note">На этом устройстве — {readingDuration(progress.seconds * 1000)}. Это время может уже входить в подтверждённый итог; значения не складываются. Неотправленные записи сохраняются до подключения.</p><GuestGoalImport store={store} saved={value => { setConfirmed(value); setRemoteError(''); }} />{remoteError && <p className="description" role="alert">{remoteError}</p>}<button className="text-button section" disabled={busy} onClick={() => setRefresh(value => value + 1)}>Обновить цель и итог аккаунта</button></>}
  </>}
 </section>;
}
