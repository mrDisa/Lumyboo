import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLiveQuery } from 'dexie-react-hooks';
import { accountDatabase } from '../lib/account-reading';
import { loadReadingSessionHistory, readingDuration } from '../lib/reading-session-history';
import catalog from '../data/catalog.json';

export function AccountReadingHistory({ accountId }: { accountId: string }) {
 const [expanded, setExpanded] = useState(false);
 const [cursors, setCursors] = useState(['']);
 const cursor = cursors[cursors.length - 1];
 const device = useLiveQuery(() => accountDatabase(accountId).metadata.get('device'), [accountId]);
 const query = useQuery({
  queryKey: ['account-reading-history', accountId, cursor],
  queryFn: ({ signal }) => loadReadingSessionHistory(accountId, cursor, signal),
  enabled: expanded, retry: false, gcTime: 0, networkMode: 'always',
 });
 return <div className="section"><button className="text-button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>Сохранённое время с устройств</button>{expanded && <>
  <p className="reader-note section">Записи, сохранённые в этом аккаунте. День указан по часам устройства. Новое чтение появляется после сохранения времени и обновления списка.</p>
  {query.isError ? <p className="description" role="alert">{query.error.message}</p> : query.isPending ? <p className="description" role="status">Загружаем историю времени…</p> : <>
   <p className="description section" role="status">Страница {cursors.length}{query.isFetching ? ' · Обновляем…' : ''}</p>
   {query.data.items.length ? <ul>{query.data.items.map(entry => {
    const book = catalog.find(book => book.id === entry.bookId);
    return <li className="section" key={entry.sessionId}><h3>{book?.title ?? 'Книга вне текущего каталога'}</h3><p className="description"><time dateTime={entry.day}>{entry.day.split('-').reverse().join('.')}</time> · {readingDuration(entry.milliseconds)}</p><p className="reader-note">{device?.deviceId ? device.deviceId === entry.deviceId ? 'Это устройство' : 'Другое устройство' : 'Устройство не определено'}{book?.version !== entry.version ? ' · издание вне текущего каталога' : ''}</p></li>;
   })}</ul> : <p className="description section">Сохранённых записей на этой странице пока нет.</p>}
  </>}
  <button className="text-button section" disabled={query.isFetching} onClick={() => { if (cursor) setCursors(['']); else void query.refetch(); }}>{query.isFetching ? 'Загружаем…' : 'Обновить с начала'}</button>
  {cursors.length > 1 && <button className="secondary section" disabled={query.isFetching} onClick={() => setCursors(previous => previous.slice(0, -1))}>Предыдущая страница</button>}
  {!query.isError && !!query.data?.nextCursor && <button className="secondary section" disabled={query.isFetching} onClick={() => setCursors(previous => [...previous, query.data.nextCursor])}>Следующая страница</button>}
  <p className="reader-note section">История не прибавляется к минутам на устройстве и не начисляет награды или серии.</p>
 </>}</div>;
}
