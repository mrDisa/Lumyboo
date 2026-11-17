import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLiveQuery } from 'dexie-react-hooks';
import type { AccountSession } from '../lib/auth';
import { db } from '../lib/db';
import { useApp } from '../lib/context';
import { importGuestShelf, loadAccountShelf } from '../lib/shelf';
import { Icon, Modal } from './ui';
import styles from './AccountShelf.module.css';
import catalog from '../data/catalog.json';
import { TransferBook } from './TransferBook';
export function AccountShelf({ session }: { session: AccountSession }) {
 const { act } = useApp(); const client = useQueryClient();
 const [preview, setPreview] = useState<string[] | null>(null); const [busy, setBusy] = useState(false);
 const guest = useLiveQuery(() => db.shelf.toArray());
 const queryKey = ['account-shelf', session.user.id];
 const query = useQuery({ queryKey, queryFn: ({ signal }) => loadAccountShelf(session.user.id, signal), retry: false, gcTime: 0, networkMode: 'always' });
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
 return <div className={styles.shelf}>
  <div className={styles.heading}><div><span className="eyebrow">Твои книги</span><h3>Полка аккаунта</h3></div>{query.isSuccess && <strong aria-label={`Книг на полке: ${query.data.bookIds.length}`}>{query.data.bookIds.length}</strong>}</div>
  {query.isPending ? <div className={styles.notice} role="status"><Icon name="books" /><b>Загружаем полку…</b></div> : query.isError ? <div className={styles.notice} role="alert"><Icon name="books" /><b>Полка пока недоступна</b><button className="secondary" disabled={query.isFetching || busy} onClick={() => void query.refetch()}>Повторить загрузку<Icon name="arrow" /></button><details className="day-details"><summary>Подробности</summary><p className="description">{query.error.message}</p></details></div> : query.data.bookIds.length ? <ul className={styles.books}>{query.data.bookIds.map(id => {
   const available = catalog.some(book => book.id === id);
   return <li className={styles.book} key={id}><TransferBook bookId={id}>{!available && <small>Нет в текущем каталоге</small>}</TransferBook>{available && <Link className="primary" to="/account/read/$bookId" params={{ bookId: id }}>Продолжить чтение<Icon name="arrow" /></Link>}</li>;
  })}</ul> : <div className={styles.notice}><Icon name="books" /><b>Место для первой истории</b><p>Сохрани книги в гостевую полку, затем скопируй их сюда.</p><Link className="secondary" to="/catalog">Выбрать книгу<Icon name="arrow" /></Link></div>}
  <section className={styles.import} aria-label="Перенос гостевой полки"><div><Icon name="books" /><span><b>С гостевой полки</b><small>Книги останутся и на устройстве</small></span>{guest && <strong>{guest.length}</strong>}</div><button className="secondary" disabled={!guest?.length || busy} onClick={() => setPreview(guest!.map(book => book.bookId))}>Скопировать в аккаунт<Icon name="arrow" /></button>{guest && !guest.length && <p>Сначала добавь книги в гостевую полку в каталоге.</p>}</section>
  <details className="day-details"><summary>Полка и сохранение чтения</summary><p className="description">Книги аккаунта сохраняются на сервере. Место аккаунта сохраняется при выходе из читалки. Закладки и изменения гостевой полки можно перенести отдельно.</p></details>{preview && <Modal title="Скопировать книги в аккаунт?" close={() => { if (!busy) setPreview(null); }}><p className="description account-email">Аккаунт: {session.user.email}</p><div className="transfer-result"><p className="eyebrow">Добавим к полке аккаунта</p><p className="transfer-count"><strong>{preview.length}</strong> к копированию</p><p className="transfer-caption">Гостевая полка останется на устройстве</p></div><div className="transfer-list">{preview.map(id => <TransferBook key={id} bookId={id} />)}</div><details className="day-details section"><summary>Что будет с сохранёнными книгами</summary><p className="description">Добавим эти книги к полке аккаунта. Уже сохранённые книги останутся. Гостевая полка, прогресс и закладки на устройстве сохранятся.</p></details><button className="primary section" disabled={busy} aria-busy={busy} onClick={() => void copy()}>{busy ? 'Копируем…' : 'Скопировать книги'}</button><button className="secondary section" disabled={busy} onClick={() => setPreview(null)}>Пока оставить на устройстве</button></Modal>}</div>;
}
