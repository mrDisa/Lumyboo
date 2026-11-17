import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import type { LocalDatabase } from '../lib/db';
import { loadLocalReadingDay } from '../lib/local-reading-time';
import { readingDuration } from '../lib/reading-session-history';
import catalog from '../data/catalog.json';
import { Modal } from './ui';
import { TransferBook } from './TransferBook';

export function LocalReadingDay({ store, day, close }: { store: LocalDatabase; day: string; close: () => void }) {
 const [attempt, setAttempt] = useState(0);
 const [limit, setLimit] = useState(20);
 const [state, setState] = useState<{ value?: Awaited<ReturnType<typeof loadLocalReadingDay>>; error?: boolean }>({});
 useEffect(() => {
  setState({});
  const subscription = liveQuery(() => loadLocalReadingDay(store, day)).subscribe({
   next: value => setState({ value }), error: () => setState({ error: true }),
  });
  return () => subscription.unsubscribe();
 }, [store, day, attempt]);
 return <Modal title={`Чтение за ${day.split('-').reverse().join('.')}`} close={close}>
  <p className="transfer-notice">На этом устройстве · {store.scope === 'guest' ? 'гостевое чтение' : 'этот аккаунт'}</p>
  {state.error ? <p className="description section" role="alert">Не удалось загрузить книги за день. <button className="text-button" onClick={() => setAttempt(value => value + 1)}>Повторить</button></p> : !state.value ? <p className="description section" role="status">Загружаем книги…</p> : state.value.editions.length ? <>
   <div className="transfer-result"><span className="eyebrow">Всего за день</span><div className="reading-session-result"><strong>{readingDuration(state.value.milliseconds)}</strong><span>Книг и изданий · {state.value.editions.length}</span></div></div>
   <ul className="session-history">{state.value.editions.slice(0, limit).map(row => {
    const book = catalog.find(book => book.id === row.bookId);
    return <li className="transfer-card" key={JSON.stringify([row.bookId, row.version ?? null])}>
     <TransferBook bookId={row.bookId} fallback="Книга вне текущего каталога" />
     <div className="session-history-result"><strong>{readingDuration(row.milliseconds)}</strong></div>
     <div className="local-day-share" role="img" aria-label={`${Math.round(row.milliseconds / state.value!.milliseconds * 100)}% времени за день`}><span style={{ width: `${row.milliseconds / state.value!.milliseconds * 100}%` }} /></div>
     <div className="session-history-tags"><span>{row.version ? `Издание ${row.version}` : 'Издание не указано'}</span>{book && row.version && book.version !== row.version && <span>Издание вне каталога</span>}</div>
    </li>;
   })}</ul>
   {state.value.editions.length > limit && <button className="text-button section" onClick={() => setLimit(value => value + 20)}>Показать ещё · осталось {state.value.editions.length - limit}</button>}
  </> : <p className="description section">За этот день пока нет сохранённого времени.</p>}
  <details className="day-details section"><summary>Что входит в этот день</summary><p className="description">Сохранённое время за книгами и изданиями на этом устройстве. Дата — по часам устройства во время чтения. Серверная история и чтение других профилей сюда не добавляются.</p></details>
 </Modal>;
}
