import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLiveQuery } from 'dexie-react-hooks';
import type { AccountSession } from '../lib/auth';
import { db } from '../lib/db';
import { useApp } from '../lib/context';
import { bookmarkEntry, bookmarkKey, importGuestBookmarks, loadAccountBookmarks, type BookmarkEntry } from '../lib/bookmarks';
import { Modal } from './ui';
import catalog from '../data/catalog.json';
export function AccountBookmarks({ session }: { session: AccountSession }) {
 const { act } = useApp(); const client = useQueryClient();
 const [preview, setPreview] = useState<BookmarkEntry[] | null>(null);
 const [error, setError] = useState('');
 const [selected, setSelected] = useState<string[]>([]); const [busy, setBusy] = useState(false);
 const guest = useLiveQuery(() => db.bookmarks.toArray());
 const queryKey = ['account-bookmarks', session.user.id];
 const query = useQuery({ queryKey, queryFn: ({ signal }) => loadAccountBookmarks(session.user.id, signal), retry: false, gcTime: 0, networkMode: 'always' });
 const title = (entry: BookmarkEntry) => `${catalog.find(book => book.id === entry.bookId)?.title ?? entry.bookId} · ${entry.label || `Глава ${entry.chapter + 1}`}`;
 async function copy() {
  if (!preview || !selected.length || busy) return;
  setBusy(true); setError('');
  const copied = await act(async () => {
   await client.cancelQueries({ queryKey });
   try {
    const result = await importGuestBookmarks(session, preview.filter(entry => selected.includes(bookmarkKey(entry))));
    client.setQueryData(queryKey, result);
   } catch (error) {
    setError(error instanceof Error ? error.message : 'Не удалось скопировать закладки. Попробуй ещё раз.');
    throw error;
   }
  }, 'Закладки скопированы в аккаунт');
  if (copied) setPreview(null);
  setBusy(false);
 }
 return <div className="section"><h3>Закладки аккаунта</h3>{query.isPending ? <p className="description" role="status">Загружаем закладки…</p> : query.isError ? <><p className="description" role="status">{query.error.message}</p><button className="text-button" disabled={query.isFetching || busy} onClick={() => void query.refetch()}>Повторить загрузку</button></> : query.data.bookmarks.length ? <ul>{query.data.bookmarks.map(entry => <li key={bookmarkKey(entry)}>{title(entry)}</li>)}</ul> : <p className="description">Пока нет сохранённых закладок.</p>}<button className="secondary section" disabled={!guest?.length || busy} onClick={() => { const entries = guest!.map(bookmarkEntry); setError(''); setPreview(entries); setSelected(entries.slice(0, 100).map(bookmarkKey)); }}>Скопировать гостевые закладки{guest?.length ? ` · ${guest.length}` : ''}</button><p className="reader-note section">Открывай книги из полки аккаунта, чтобы читать с этими закладками. Новые изменения сохраняются отдельно на этом устройстве; автоматическая отправка ещё не подключена.</p>{preview && <Modal title="Скопировать закладки?" close={() => { if (!busy) setPreview(null); }}><p className="description account-email">Аккаунт: {session.user.email}</p><p className="description">Выбери до 100 закладок. Уже сохранённые закладки аккаунта останутся без изменений. Гостевые закладки сохранятся на устройстве.</p><div>{preview.map(entry => { const key = bookmarkKey(entry); const checked = selected.includes(key); return <label className="bookmark-choice" key={key}><input type="checkbox" checked={checked} disabled={busy || !checked && selected.length >= 100} onChange={() => setSelected(previous => checked ? previous.filter(item => item !== key) : [...previous, key])} />{title(entry)}</label>; })}</div><p className="description" role="alert">{error}</p><button className="primary section" disabled={busy || !selected.length} aria-busy={busy} onClick={() => void copy()}>{busy ? 'Копируем…' : `Скопировать · ${selected.length}`}</button><button className="secondary section" disabled={busy} onClick={() => setPreview(null)}>Пока оставить на устройстве</button></Modal>}</div>;
}
