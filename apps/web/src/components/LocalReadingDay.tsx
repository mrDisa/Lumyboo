import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import type { LocalDatabase } from '../lib/db';
import { loadLocalReadingDay } from '../lib/local-reading-time';
import { readingDuration } from '../lib/reading-session-history';
import catalog from '../data/catalog.json';
import { Modal } from './ui';

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
  <p className="description">Книги и издания, за которыми сохранено время на этом устройстве {store.scope === 'guest' ? 'в гостевом режиме' : 'для этого аккаунта'}. Дата — по часам устройства.</p>
  {state.error ? <p className="description section" role="alert">Не удалось загрузить книги за день. <button className="text-button" onClick={() => setAttempt(value => value + 1)}>Повторить</button></p> : !state.value ? <p className="description section" role="status">Загружаем книги…</p> : state.value.editions.length ? <>
   <p className="description section">Всего за день: {readingDuration(state.value.milliseconds)}</p>
   <ul className="reading-day-books">{state.value.editions.slice(0, limit).map(row => {
    const book = catalog.find(book => book.id === row.bookId);
    return <li className="section" key={JSON.stringify([row.bookId, row.version ?? null])}>
     <h3>{book?.title ?? 'Книга вне текущего каталога'}</h3>
     {book && <p className="reader-note">{book.author}</p>}
     <p className="description">{readingDuration(row.milliseconds)}</p>
     <p className="reader-note">{row.version ? `Издание ${row.version}` : 'Издание не указано'}</p>
    </li>;
   })}</ul>
   {state.value.editions.length > limit && <button className="text-button section" onClick={() => setLimit(value => value + 20)}>Показать ещё · осталось {state.value.editions.length - limit}</button>}
  </> : <p className="description section">За этот день пока нет сохранённого времени.</p>}
  <p className="reader-note section">Серверная история и чтение других профилей сюда не добавляются.</p>
 </Modal>;
}
