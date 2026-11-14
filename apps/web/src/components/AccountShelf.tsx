import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLiveQuery } from 'dexie-react-hooks';
import type { AccountSession } from '../lib/auth';
import { db } from '../lib/db';
import { useApp } from '../lib/context';
import { importGuestShelf, loadAccountShelf } from '../lib/shelf';
import { Modal } from './ui';
import catalog from '../data/catalog.json';
export function AccountShelf({ session }: { session: AccountSession }) {
 const { act } = useApp(); const client = useQueryClient();
 const [preview, setPreview] = useState<string[] | null>(null); const [busy, setBusy] = useState(false);
 const guest = useLiveQuery(() => db.shelf.toArray());
 const queryKey = ['account-shelf', session.user.id];
 const query = useQuery({ queryKey, queryFn: ({ signal }) => loadAccountShelf(session.user.id, signal), retry: false, gcTime: 0, networkMode: 'always' });
 const title = (id: string) => catalog.find(book => book.id === id)?.title ?? id;
 async function copy() {
  if (!preview || busy) return;
  setBusy(true);
  const copied = await act(async () => {
   // Cancel an earlier GET so its older result cannot overwrite the import.
   await client.cancelQueries({ queryKey });
   const result = await importGuestShelf(session, preview);
   client.setQueryData(queryKey, result);
  }, 'Гостевая полка скопирована в аккаунт');
  if (copied) setPreview(null);
  setBusy(false);
 }
 return <div className="section"><h3>Полка аккаунта</h3>{query.isPending ? <p className="description" role="status">Загружаем полку…</p> : query.isError ? <><p className="description" role="status">{query.error.message}</p><button className="text-button" disabled={query.isFetching || busy} onClick={() => void query.refetch()}>Повторить загрузку</button></> : query.data.bookIds.length ? <ul>{query.data.bookIds.map(id => <li key={id}>{catalog.some(book => book.id === id) ? <Link className="text-button" to="/account/read/$bookId" params={{ bookId: id }}>{title(id)}</Link> : title(id)}</li>)}</ul> : <p className="description">Пока пусто. Можно скопировать книги с гостевой полки.</p>}<button className="secondary section" disabled={!guest?.length || busy} onClick={() => setPreview(guest!.map(book => book.bookId))}>Скопировать гостевую полку{guest?.length ? ` · ${guest.length}` : ''}</button><p className="reader-note section">Книги аккаунта сохраняются на сервере. Место аккаунта сохраняется при выходе из читалки. Закладки и изменения гостевой полки можно перенести отдельно.</p>{preview && <Modal title="Скопировать книги в аккаунт?" close={() => { if (!busy) setPreview(null); }}><p className="description account-email">Аккаунт: {session.user.email}</p><ul>{preview.map(id => <li key={id}>{title(id)}</li>)}</ul><p className="description">Добавим эти книги к полке аккаунта. Уже сохранённые книги останутся. Гостевая полка, прогресс и закладки на устройстве сохранятся.</p><button className="primary section" disabled={busy} aria-busy={busy} onClick={() => void copy()}>{busy ? 'Копируем…' : 'Скопировать книги'}</button><button className="secondary section" disabled={busy} onClick={() => setPreview(null)}>Пока оставить на устройстве</button></Modal>}</div>;
}
