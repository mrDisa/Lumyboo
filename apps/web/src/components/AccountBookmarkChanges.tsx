import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLiveQuery } from 'dexie-react-hooks';
import type { AccountSession } from '../lib/auth';
import { accountDatabase } from '../lib/account-reading';
import { bookmarkId } from '../lib/db';
import { bookmarkReviews, reviewedBookmarkChange } from '../lib/bookmark-review';
import { loadAccountBookmarkState, sameBookmark, type BookmarkChange, type BookmarkEntry, type BookmarkState } from '../lib/bookmarks';
import { rememberBookmarkChoice, sendBookmarkChoice, forgetBookmarkChoice } from '../lib/bookmark-choices';
import { loadBook, type Book } from '../lib/books';
import { ApiError } from '../lib/api';
import { useApp } from '../lib/context';
import { Modal } from './ui';
import catalog from '../data/catalog.json';

type Preview = { change: BookmarkChange; remote?: BookmarkState; conflict: boolean };
const title = (entry: BookmarkEntry) => catalog.find(book => book.id === entry.bookId)?.title ?? entry.bookId;
function Place({ heading, entry }: { heading: string; entry?: BookmarkEntry & { deleted?: boolean } }) {
 const book = catalog.find(book => book.id === entry?.bookId) as Book | undefined;
 const content = useQuery({ queryKey: ['book', book?.id], queryFn: () => loadBook(book!), enabled: !!book && !!entry && !entry.deleted, retry: false, staleTime: Infinity });
 const chapter = content.data && content.data.version === entry?.version && entry ? content.data.chapters[entry.chapter] : undefined;
 const paragraph = chapter?.paragraphs.findIndex(item => item.id === entry?.paragraph) ?? -1;
 return <div className="section"><h3>{heading}</h3><p className="description">{!entry ? 'Нет сохранённой закладки.' : entry.deleted ? 'Закладка удалена.' : `${entry.label || 'Без подписи'} · глава ${entry.chapter + 1}${paragraph >= 0 ? ` · абзац ${paragraph + 1}` : ''} · ${Math.round(entry.offset * 100)}% абзаца${book && entry.version !== book.version ? ' · прежнее издание' : ''}`}</p>{paragraph >= 0 && <p className="description">«{chapter!.paragraphs[paragraph].text.slice(0, 140)}…»</p>}{content.isError && <p className="reader-note">Текст для сравнения недоступен.</p>}</div>;
}
export function AccountBookmarkChanges({ session }: { session: AccountSession }) {
 const store = accountDatabase(session.user.id); const client = useQueryClient(); const { notify } = useApp();
 const [preview, setPreview] = useState<Preview | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
 const local = useLiveQuery(() => store.bookmarks.toArray(), [store]);
 const pending = useLiveQuery(() => store.bookmarkChoices.toArray(), [store]);
 const queryKey = ['account-bookmark-state', session.user.id];
 const query = useQuery({ queryKey, queryFn: ({ signal }) => loadAccountBookmarkState(session.user.id, signal), retry: false, gcTime: 0, networkMode: 'always' });
 const reviews = bookmarkReviews(local ?? [], query.data?.bookmarks ?? []);
 function review(device: BookmarkEntry | undefined, remote: BookmarkState | undefined, deleted: boolean) {
  setError(''); setPreview({ change: reviewedBookmarkChange(device, remote, deleted), remote, conflict: false });
 }
 async function save() {
  if (!preview || busy || preview.conflict) return;
  setBusy(true); setError('');
  try {
   await rememberBookmarkChoice(store, preview.change);
   await sendBookmarkChoice(store, session, bookmarkId(preview.change.bookmark), preview.change.operationId);
   setPreview(null); notify(preview.change.deleted ? 'Закладка удалена из аккаунта' : 'Закладка сохранена в аккаунте');
   await Promise.all([client.invalidateQueries({ queryKey }), client.invalidateQueries({ queryKey: ['account-bookmarks', session.user.id] })]);
  } catch (error) {
   setError(error instanceof Error ? error.message : 'Не удалось сохранить закладку.');
   if (error instanceof ApiError && error.code === 'bookmark_conflict') {
    setPreview(previous => previous && { ...previous, conflict: true });
    await client.invalidateQueries({ queryKey });
   }
  } finally { setBusy(false); }
 }
 async function discard() {
  if (!preview || busy) return;
  setBusy(true); setError('');
  try {
   await forgetBookmarkChoice(store, bookmarkId(preview.change.bookmark), preview.change.operationId);
   setPreview(null); await client.invalidateQueries({ queryKey });
  } catch (error) { setError(error instanceof Error ? error.message : 'Не удалось отменить повторы.'); }
  finally { setBusy(false); }
 }
 const saved = preview && pending?.find(item => item.change.operationId === preview.change.operationId);
 const conflict = preview?.conflict || saved?.conflict;
 return <div className="section"><h3>Сохранить изменения закладок</h3>
  {pending?.map(item => <div className="section" key={item.id}><p className="description">{title(item.change.bookmark)}: {item.conflict ? 'закладка аккаунта изменилась. Нужно сравнить заново.' : 'сохранение не подтверждено.'}</p><button className="secondary" disabled={busy} onClick={() => { setError(''); setPreview({ change: item.change, conflict: item.conflict }); }}>Открыть незавершённое сохранение закладки</button></div>)}
  {query.isPending || !local || !pending ? <p className="description" role="status">Загружаем варианты закладок…</p> : query.isError ? <><p className="description" role="status">{query.error.message}</p><button className="text-button" disabled={busy || query.isFetching} onClick={() => void query.refetch()}>Повторить загрузку вариантов</button></> : reviews.length ? reviews.map(item => <div className="section" key={item.key}><h3>{title((item.local ?? item.remote)!)}</h3><Place heading="Аккаунт на устройстве" entry={item.local} /><Place heading="В аккаунте" entry={item.remote} />{item.local && <button className="secondary section" disabled={busy || query.isFetching || pending.some(saved => saved.id === bookmarkId(item.local!))} onClick={() => review(item.local, item.remote, false)}>{item.remote?.deleted ? 'Сравнить и восстановить в аккаунте' : item.remote && sameBookmark(item.local, item.remote) ? 'Подтвердить закладку устройства' : 'Сравнить и сохранить закладку'}</button>}{item.remote && !item.remote.deleted && <button className="text-button section" disabled={busy || query.isFetching || pending.some(saved => saved.id === bookmarkId(item.remote!))} onClick={() => review(item.local, item.remote, true)}>Сравнить и удалить из аккаунта</button>}</div>) : <p className="description">Нет закладок для сравнения.</p>}
  <p className="reader-note section">Каждое изменение отправляется по твоему выбору. Сохранение и удаление в аккаунте не меняют закладку на устройстве. Гостевые закладки остаются отдельно.</p>
  {preview && <Modal title={preview.change.deleted ? 'Удалить закладку из аккаунта?' : 'Сохранить закладку в аккаунте?'} close={() => { if (!busy) setPreview(null); }}><p className="description account-email">Аккаунт: {session.user.email}</p><h3>{title(preview.change.bookmark)}</h3><Place heading={preview.change.deleted ? 'Выбранная для удаления закладка' : 'Выбранная закладка устройства'} entry={preview.change.bookmark} />{preview.remote && <Place heading="Вариант аккаунта при сравнении" entry={preview.remote} />}<p className="description section">{preview.change.deleted ? 'Эта закладка будет удалена из аккаунта.' : 'Выбранная закладка заменит вариант аккаунта, включая ранее удалённый.'} Закладка на устройстве останется без изменений.</p>{conflict && <p className="description" role="status">Вариант аккаунта изменился. Отмени этот выбор и сравни заново.</p>}<p className="description" role="alert">{error}</p><button className="primary section" disabled={busy || !!conflict} aria-busy={busy} onClick={() => void save()}>{busy ? 'Сохраняем…' : saved ? 'Повторить выбранное изменение' : preview.change.deleted ? 'Удалить из аккаунта' : 'Сохранить в аккаунте'}</button><button className="secondary section" disabled={busy} onClick={() => setPreview(null)}>Закрыть</button>{saved && <><p className="description section">Повтор отправит прежний выбор. Отмена повторов не откатывает изменение, которое сервер уже мог принять. Перед новым выбором загрузим варианты снова.</p><button className="text-button section" disabled={busy} onClick={() => void discard()}>Отменить дальнейшие повторы и сравнить заново</button></>}</Modal>}
 </div>;
}
