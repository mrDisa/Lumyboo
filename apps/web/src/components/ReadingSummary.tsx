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
 return <>
  <p className="eyebrow">ЭТО ВРЕМЯ — ДЛЯ ТЕБЯ</p>
  <h3>За это чтение · {readingDuration(data.milliseconds)}</h3>
  <p className="description section">{data.milliseconds ? 'Каждая минута остаётся с тобой.' : 'Даже короткая встреча с книгой — начало.'}</p>
  {data.days.some(row => row.day !== data.day) && <p className="description section">По дням: {data.days.map(row => `${row.day.split('-').reverse().join('.')} — ${readingDuration(row.milliseconds)}`).join('; ')}. Время осталось в своём дне.</p>}
  <h3 className="section">{guest ? 'Твой день' : 'На этом устройстве'} · {data.day.split('-').reverse().join('.')}</h3>
  <p className="description">{readingDuration(Math.round(data.progress.seconds * 1000))} из {data.progress.minutes} мин</p>
  <progress className="goal-progress" aria-label="Локальный прогресс дневной цели" value={Math.min(data.progress.seconds, data.progress.minutes * 60)} max={data.progress.minutes * 60} />
  <p className="description section">{data.progress.complete ? guest ? 'Дневная цель выполнена.' : 'Дневная цель выполнена на устройстве — предварительный результат.' : `До цели осталось ${readingDuration(data.progress.remaining * 1000)}.`}</p>
  {guest ? <p className="reader-note section">Гостевое чтение сохранено на этом устройстве · {data.timeZone}.</p> : <>
   {confirmed && <><h3 className="section">Итог аккаунта</h3><p className="description">{readingDuration(confirmed.milliseconds)} из {confirmed.minutes} мин · {confirmed.complete ? 'Дневная цель выполнена и подтверждена аккаунтом.' : `До цели осталось ${readingDuration(Math.ceil(Math.max(0, confirmed.minutes * 60000 - confirmed.milliseconds) / 1000) * 1000)}.`}</p></>}
   <p className="reader-note section">Время этого чтения сохранено на устройстве и уже входит в локальный итог. Итог аккаунта учитывает принятые записи со всех устройств; часть текущего чтения ещё может ожидать отправки. Эти значения не складываются.</p>
   {localOnly ? <p className="description section">Без подключения · итог аккаунта можно обновить после входа с сетью.</p> : <><p className="description section" role="status">{busy ? 'Обновляем подтверждённый итог…' : remoteError}</p><button className="text-button section" disabled={busy} onClick={() => setRefresh(value => value + 1)}>Обновить итог аккаунта</button></>}
  </>}
 </>;
}
