import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { accountDatabase } from '../lib/account-reading';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLiveQuery } from 'dexie-react-hooks';
import type { AccountSession } from '../lib/auth';
import { db } from '../lib/db';
import { useApp } from '../lib/context';
import { ApiError } from '../lib/api';
import { loadBook, type Book } from '../lib/books';
import { chooseAccountPosition, loadAccountPositions, positionChoice, samePosition, type AccountPosition, type PositionChoice, type ReadingLocator } from '../lib/positions';
import { Modal } from './ui';
import catalog from '../data/catalog.json';
type Preview = { choice: PositionChoice; remote?: AccountPosition };
function Comparison({ preview }: { preview: Preview }) {
 const book = catalog.find(book => book.id === preview.choice.position.bookId) as Book | undefined;
 const content = useQuery({ queryKey: ['book', book?.id], queryFn: () => loadBook(book!), enabled: !!book, retry: false, staleTime: Infinity });
 function place(title: string, position?: ReadingLocator) {
  if (!position) return <div className="section"><h3>{title}</h3><p className="description">Место ещё не сохранено.</p></div>;
  const chapter = content.data?.version === position.version ? content.data.chapters[position.chapter] : undefined;
  const paragraph = chapter?.paragraphs.findIndex(p => p.id === position.paragraph) ?? -1;
  return <div className="section"><h3>{title}</h3><p className="description">Глава {position.chapter + 1}{paragraph >= 0 ? ` · абзац ${paragraph + 1} · ${Math.round(position.offset * 100)}% абзаца` : ''}{position.version !== book?.version ? ' · прежнее издание' : ''}</p>{paragraph >= 0 && <p className="description">«{chapter!.paragraphs[paragraph].text.slice(0, 140)}…»</p>}</div>;
 }
 return <>{place('Выбранное место устройства', preview.choice.position)}{place('Сохранённое место аккаунта', preview.remote)}{content.isError && <p className="description">Текст для сравнения недоступен. Главы указаны по сохранённым местам.</p>}</>;
}
export function AccountPositions({ session }: { session: AccountSession }) {
 const { notify } = useApp(); const client = useQueryClient();
 const [preview, setPreview] = useState<Preview | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [conflict, setConflict] = useState(false);
 const guestPositions = useLiveQuery(() => db.positions.toArray());
 const accountPositions = useLiveQuery(() => accountDatabase(session.user.id).positions.toArray(), [session.user.id]);
 const localLoading = !accountPositions || !guestPositions;
 const local = [...(accountPositions ?? []), ...(guestPositions ?? []).filter(p => !accountPositions?.some(a => a.bookId === p.bookId))];
 const queryKey = ['account-positions', session.user.id];
 const query = useQuery({ queryKey, queryFn: ({ signal }) => loadAccountPositions(session.user.id, signal), retry: false, gcTime: 0, networkMode: 'always' });
 const ids = [...new Set([...(local?.map(p => p.bookId) ?? []), ...(query.data?.positions.map(p => p.bookId) ?? [])])];
 async function save() {
  if (!preview || busy || conflict) return;
  setBusy(true); setError('');
  try {
   await client.cancelQueries({ queryKey });
   // Keep this exact choice/UUID on uncertain responses. No automatic retry
   // against a newer revision: that would bypass the user's comparison.
   await chooseAccountPosition(session, preview.choice);
   setPreview(null); notify('Выбранное место сохранено в аккаунте');
   await client.invalidateQueries({ queryKey });
  } catch (error) {
   setError(error instanceof Error ? error.message : 'Не удалось сохранить. Попробуй ещё раз.');
   if (error instanceof ApiError && error.status === 409) { setConflict(true); await client.invalidateQueries({ queryKey }); }
  } finally { setBusy(false); }
 }
 return <div className="section"><h3>Места чтения аккаунта</h3>{query.isPending || localLoading ? <p className="description" role="status">Загружаем места чтения…</p> : query.isError ? <><p className="description" role="status">{query.error.message}</p><button className="text-button" onClick={() => void query.refetch()}>Повторить загрузку</button></> : ids.length ? ids.map(id => {
  const device = local?.find(p => p.bookId === id); const remote = query.data.positions.find(p => p.bookId === id);
  return <div className="section" key={id}><h3>{catalog.find(b => b.id === id)?.title ?? id}</h3><p className="description">{accountPositions?.some(p => p.bookId === id) ? 'Аккаунт на устройстве' : 'Гостевое устройство'}: {device ? `глава ${device.chapter + 1}` : 'нет места'} · аккаунт: {remote ? `глава ${remote.chapter + 1}` : 'нет места'}</p>{device && (samePosition(device, remote) ? <p className="reader-note">Сохранённые места совпадают.</p> : <button className="secondary section" disabled={busy} onClick={() => { setPreview({ choice: positionChoice(device, remote), remote }); setError(''); setConflict(false); }}>Сравнить и сохранить</button>)}{catalog.some(book => book.id === id) && <Link className="secondary section" to="/account/read/$bookId" params={{ bookId: id }}>Открыть в читалке аккаунта</Link>}</div>;
 }) : <p className="description">Открой книгу — на устройстве появится место для сохранения.</p>}<p className="reader-note section">Перенос выполняется по твоему выбору. Читалка аккаунта использует отдельные места и закладки. Гостевое чтение остаётся отдельно. Сохранение места не отмечает книгу прочитанной.</p>{preview && <Modal title="Какое место оставить в аккаунте?" close={() => { if (!busy) setPreview(null); }}><p className="description account-email">Аккаунт: {session.user.email}</p><Comparison preview={preview} /><p className="description">При сохранении выбранное место устройства заменит место аккаунта. Прежний вариант аккаунта останется в истории. Место на устройстве не изменится.</p><p className="description" role="alert">{error}</p><button className="primary section" disabled={busy || conflict} aria-busy={busy} onClick={() => void save()}>{busy ? 'Сохраняем…' : 'Сохранить место устройства в аккаунте'}</button><button className="secondary section" disabled={busy} onClick={() => setPreview(null)}>{conflict ? 'Закрыть и сравнить заново' : preview.remote ? 'Оставить место аккаунта' : 'Пока оставить только на устройстве'}</button></Modal>}</div>;
}
