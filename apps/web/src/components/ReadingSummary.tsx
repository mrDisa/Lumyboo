import { DayProgress } from './DayProgress';
import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { LocalDatabase, ReadingSession } from '../lib/db';
import { loadReadingSummary, type ReadingSummaryData } from '../lib/reading-summary';
import { syncAccountGoal, type GoalSnapshot } from '../lib/account-daily-goal';
import { readingDuration } from '../lib/reading-session-history';

export function ReadingSummary({ store, sessions, localOnly }: { store: LocalDatabase; sessions: ReadingSession[]; localOnly: boolean }) {
 const [data, setData] = useState<ReadingSummaryData>();
 const [failed, setFailed] = useState(false);
 const [accepted, setAccepted] = useState<GoalSnapshot>();
 const [remoteError, setRemoteError] = useState('');
 const [refresh, setRefresh] = useState(0);
 const [busy, setBusy] = useState(false);
 const guest = store.scope === 'guest';
 const pending = useLiveQuery(() => store.outbox.count(), [store]);
 useEffect(() => {
  let disposed = false;
  void loadReadingSummary(store, sessions).then(value => { if (!disposed) setData(value); }).catch(() => { if (!disposed) setFailed(true); });
  return () => { disposed = true; };
 }, [store, sessions]);
 useEffect(() => {
  if (!data || guest || localOnly || pending === undefined) return;
  let disposed = false;
  setBusy(true); setRemoteError('');
  void syncAccountGoal(store).then(value => { if (!disposed) setAccepted(value); }).catch(() => {
   if (!disposed) setRemoteError('Не удалось обновить итог аккаунта. Чтение сохранено на устройстве.');
  }).finally(() => { if (!disposed) setBusy(false); });
  return () => { disposed = true; };
 }, [store, data, guest, localOnly, refresh, pending]);
 if (failed) return <p className="description" role="status">Чтение сохранено на устройстве. Сейчас не удалось загрузить итог дня — его можно посмотреть в профиле.</p>;
 if (!data) return <p className="description" role="status">Подводим итог чтения…</p>;
 const confirmed = accepted?.progress.day === data.day ? accepted.progress : undefined;
 const milliseconds = confirmed ? confirmed.milliseconds : data.progress.seconds * 1000;
 const minutes = confirmed ? confirmed.minutes : data.progress.minutes;
 const complete = confirmed ? confirmed.complete : data.progress.complete;
 return <div className="reading-summary">
  <p className="eyebrow">ЭТО ВРЕМЯ — ДЛЯ ТЕБЯ</p>
  <div className="reading-session-result"><span>За это чтение</span><strong>{readingDuration(data.milliseconds)}</strong></div>
  <DayProgress milliseconds={milliseconds} minutes={minutes} complete={complete} label={guest ? 'Твой день · на устройстве' : confirmed ? 'Подтверждено аккаунтом' : 'На устройстве · предварительно'} progressLabel={confirmed ? 'Подтверждённый прогресс дневной цели' : 'Локальный прогресс дневной цели'} />
  <details className="day-details section"><summary>Подробнее о чтении</summary>
   <dl className="reading-days"><div><dt>Дата</dt><dd>{data.day.split('-').reverse().join('.')}</dd></div><div><dt>На устройстве</dt><dd>{readingDuration(data.progress.seconds * 1000)}</dd></div></dl>
   {data.days.some(row => row.day !== data.day) && <p className="reader-note section">По дням: {data.days.map(row => `${row.day.split('-').reverse().join('.')} — ${readingDuration(row.milliseconds)}`).join('; ')}. Время осталось в своём дне.</p>}
   {guest ? <p className="reader-note section">Гостевое чтение сохранено на этом устройстве · {data.timeZone}.</p> : <p className="reader-note section">Время этого чтения сохранено на устройстве и уже входит в локальный итог. Итог аккаунта учитывает принятые записи со всех устройств; часть текущего чтения ещё может ожидать отправки. Эти значения не складываются.</p>}
  </details>
  {!guest && (localOnly ? <p className="description section">Без подключения · итог аккаунта можно обновить после входа с сетью.</p> : <>
   {(busy || remoteError) && <p className="description section" role="status">{busy ? 'Обновляем подтверждённый итог…' : remoteError}</p>}
   <button className="text-button section" disabled={busy} onClick={() => setRefresh(value => value + 1)}>Обновить итог аккаунта</button>
  </>)}
 </div>;
}
