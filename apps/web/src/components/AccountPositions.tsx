import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { accountDatabase } from '../lib/account-reading';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLiveQuery } from 'dexie-react-hooks';
import type { AccountSession } from '../lib/auth';
import { db } from '../lib/db';
import { acceptPositionDownload, reviewPositionDownload, type PositionDownload } from '../lib/position-download';
import { rememberPositionChoice, sendPositionChoice, forgetPositionChoice } from '../lib/position-choices';
import { useApp } from '../lib/context';
import { ApiError } from '../lib/api';
import { loadBook, type Book } from '../lib/books';
import { loadAccountPositions, positionChoice, samePosition, type AccountPosition, type PositionChoice } from '../lib/positions';
import { Modal } from './ui';
import catalog from '../data/catalog.json';
import { Place } from './PositionPlace';
import { TransferBook } from './TransferBook';
import { AccountPositionHistory } from './AccountPositionHistory';
type Preview = { choice: PositionChoice; remote?: AccountPosition };

function Comparison({ preview }: { preview: Preview }) {
 const bookId = preview.choice.position.bookId;
 return <div className="transfer-comparison"><Place title="Выбранное место устройства" position={preview.choice.position} bookId={bookId} /><Place title="Сохранённое место аккаунта" position={preview.remote} bookId={bookId} /></div>;
}
export function AccountPositions({ session }: { session: AccountSession }) {
 const { notify } = useApp(); const client = useQueryClient();
 const [download, setDownload] = useState<PositionDownload | null>(null);
 const [preview, setPreview] = useState<Preview | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [conflict, setConflict] = useState(false);
 const store = accountDatabase(session.user.id);
 const pending = useLiveQuery(() => store.positionChoices.toArray(), [session.user.id]);
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
   await rememberPositionChoice(store, { bookId: preview.choice.position.bookId, ...preview, conflict: false });
   await sendPositionChoice(store, session, preview.choice.position.bookId, preview.choice.operationId);
   setPreview(null); notify('Выбранное место сохранено в аккаунте');
   await client.invalidateQueries({ queryKey });
  } catch (error) {
   setError(error instanceof Error ? error.message : 'Не удалось сохранить. Попробуй ещё раз.');
   if (error instanceof ApiError && error.code === 'position_conflict') { setConflict(true); await client.invalidateQueries({ queryKey }); }
  } finally { setBusy(false); }
 }
 async function discard() {
  if (!preview || busy) return;
  setBusy(true); setError('');
  try { await forgetPositionChoice(store, preview.choice.position.bookId, preview.choice.operationId); await client.invalidateQueries({ queryKey }); setPreview(null); }
  catch (error) { setError(error instanceof Error ? error.message : 'Не удалось отменить сохранение.'); }
  finally { setBusy(false); }
 }
 async function reviewDownload(remote: AccountPosition) {
  if (busy) return;
  setBusy(true); setError('');
  try { setDownload(await reviewPositionDownload(store, session.user.id, remote)); }
  catch (error) { setError(error instanceof Error ? error.message : 'Не удалось открыть сравнение.'); }
  finally { setBusy(false); }
 }
 async function acceptDownload() {
  if (!download || busy) return;
  setBusy(true); setError('');
  try {
   const book = catalog.find(book => book.id === download.remote.bookId) as Book | undefined;
   if (!book) throw new Error('Это издание недоступно в каталоге.');
   await acceptPositionDownload(store, download, await loadBook(book));
   setDownload(null); notify('Место аккаунта принято на устройстве');
  } catch (error) { setError(error instanceof Error ? error.message : 'Не удалось принять место.'); }
  finally { setBusy(false); }
 }
 return <div className="section"><h3>Места чтения аккаунта</h3>{!preview && !download && error && <p className="description" role="alert">{error}</p>}{pending?.map(saved => <div className="transfer-card transfer-pending" key={saved.bookId}><TransferBook bookId={saved.bookId} /><p className="transfer-notice">{saved.conflict ? 'Место изменилось · сравни заново' : 'Сохранение не подтверждено'}</p><button className="secondary" disabled={busy} onClick={() => { setPreview({ choice: saved.choice, remote: saved.remote }); setConflict(saved.conflict); setError(''); }}>Открыть незавершённое сохранение</button></div>)}{query.isPending || localLoading ? <p className="description" role="status">Загружаем места чтения…</p> : query.isError ? <><p className="description" role="status">{query.error.message}</p><button className="text-button" onClick={() => void query.refetch()}>Повторить загрузку</button></> : ids.length ? ids.map(id => {
  const device = local?.find(p => p.bookId === id); const remote = query.data.positions.find(p => p.bookId === id);
  const guest = guestPositions?.find(p => p.bookId === id);
  const separateGuest = accountPositions?.some(p => p.bookId === id) && guest && !samePosition(guest, device);
  return <div className="transfer-card" key={id}><TransferBook bookId={id} /><div className="transfer-places"><div><small>{accountPositions?.some(p => p.bookId === id) ? 'Аккаунт на устройстве' : 'Гость на устройстве'}</small><strong>{device ? `Глава ${device.chapter + 1}` : 'Нет места'}</strong></div><div><small>В аккаунте</small><strong>{remote ? `Глава ${remote.chapter + 1}` : 'Нет места'}</strong></div></div>{device && (samePosition(device, remote) ? <p className="reader-note">Сохранённые места совпадают.</p> : <button className="secondary section" disabled={busy || query.isFetching || !pending || pending.some(saved => saved.bookId === id)} onClick={() => { setPreview({ choice: positionChoice(device, remote), remote }); setError(''); setConflict(false); }}>Сравнить и сохранить</button>)}{separateGuest && <><div className="transfer-comparison"><Place title="Гостевое место на устройстве" position={guest} bookId={id} /></div>{samePosition(guest, remote) ? <p className="reader-note">Гостевое место уже сохранено в аккаунте.</p> : <button className="secondary section" disabled={busy || query.isFetching || !pending || pending.some(saved => saved.bookId === id)} onClick={() => { setPreview({ choice: positionChoice(guest, remote), remote }); setError(''); setConflict(false); }}>Сравнить и перенести гостевое место</button>}</>}{remote && <button className="secondary section" disabled={busy || query.isFetching || !pending || pending.some(saved => saved.bookId === id)} onClick={() => void reviewDownload(remote)}>Сравнить и принять место на устройство</button>}{catalog.some(book => book.id === id) && <Link className="secondary section" to="/account/read/$bookId" params={{ bookId: id }}>Открыть в читалке аккаунта</Link>}</div>;
 }) : <p className="description">Открой книгу — на устройстве появится место для сохранения.</p>}<AccountPositionHistory session={session} /><details className="day-details section"><summary>Как устроен перенос мест</summary><p className="description">Перенос выполняется по твоему выбору. Читалка аккаунта использует отдельные места и закладки. Гостевое чтение остаётся отдельно. Сохранение места не отмечает книгу прочитанной.</p></details>{download && <Modal title="Принять место аккаунта?" close={() => { if (!busy) setDownload(null); }}><p className="description account-email">Аккаунт: {session.user.email}</p><TransferBook bookId={download.remote.bookId} /><div className="transfer-comparison"><Place title="Аккаунт на устройстве" position={download.local} bookId={download.remote.bookId} /><Place title="Выбранное место аккаунта" position={download.remote} bookId={download.remote.bookId} /></div><p className="transfer-notice">Заменим место аккаунта на этом устройстве</p><details className="day-details section"><summary>История и ожидающие изменения</summary><p className="description">Выбранное место заменит место этого аккаунта на устройстве. Прежний вариант останется в локальной истории, а показанные изменения места больше не будут ожидать отправки. Серверное место, гостевое чтение, закладки и время не изменятся.</p></details><p className="description" role="alert">{error}</p><button className="primary section" disabled={busy} aria-busy={busy} onClick={() => void acceptDownload()}>{busy ? 'Принимаем…' : 'Принять место на устройство'}</button><button className="secondary section" disabled={busy} onClick={() => setDownload(null)}>Закрыть</button></Modal>}{preview && <Modal title="Какое место оставить в аккаунте?" close={() => { if (!busy) setPreview(null); }}><p className="description account-email">Аккаунт: {session.user.email}</p><TransferBook bookId={preview.choice.position.bookId} /><Comparison preview={preview} /><p className="transfer-notice">{conflict ? 'Место аккаунта изменилось · отмени выбор и сравни заново' : 'Выбранное место заменит место в аккаунте'}</p><details className="day-details section"><summary>Что сохранится в истории</summary><p className="description">При сохранении выбранное место устройства заменит место аккаунта. Прежний вариант аккаунта останется в истории. Место на устройстве не изменится.</p></details><p className="description" role="alert">{error}</p><button className="primary section" disabled={busy || conflict} aria-busy={busy} onClick={() => void save()}>{busy ? 'Сохраняем…' : 'Сохранить выбранное место в аккаунте'}</button><button className="secondary section" disabled={busy} onClick={() => setPreview(null)}>Закрыть</button>{pending?.some(saved => saved.choice.operationId === preview.choice.operationId) && <><p className="description section">Выбор сохранён на устройстве. Повтор отправит то же место, даже если ты продолжил чтение. Отмена не откатывает уже принятое сервером сохранение; перед новым выбором места будут загружены снова.</p><button className="text-button section" disabled={busy} onClick={() => void discard()}>{conflict ? 'Отменить этот выбор и сравнить заново' : 'Отменить дальнейшие повторы'}</button></>}</Modal>}</div>;
}
