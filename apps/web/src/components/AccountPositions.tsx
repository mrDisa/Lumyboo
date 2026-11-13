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
import { loadAccountPositions, positionChoice, samePosition, type AccountPosition, type PositionChoice, type ReadingLocator } from '../lib/positions';
import { Modal } from './ui';
import catalog from '../data/catalog.json';
type Preview = { choice: PositionChoice; remote?: AccountPosition };
function Place({ title, position, bookId }: { title: string; position?: ReadingLocator; bookId: string }) {
 const book = catalog.find(book => book.id === bookId) as Book | undefined;
 const content = useQuery({ queryKey: ['book', book?.id], queryFn: () => loadBook(book!), enabled: !!book && !!position, retry: false, staleTime: Infinity });
 const chapter = content.data && content.data.version === position?.version && position ? content.data.chapters[position.chapter] : undefined;
 const paragraph = chapter?.paragraphs.findIndex(p => p.id === position?.paragraph) ?? -1;
 return <div className="section"><h3>{title}</h3><p className="description">{!position ? 'Место ещё не сохранено.' : `Глава ${position.chapter + 1}${paragraph >= 0 ? ` · абзац ${paragraph + 1} · ${Math.round(position.offset * 100)}% абзаца` : ''}${position.version !== book?.version ? ' · прежнее издание' : ''}`}</p>{paragraph >= 0 && <p className="description">«{chapter!.paragraphs[paragraph].text.slice(0, 140)}…»</p>}{content.isError && <p className="description">Текст для сравнения недоступен. Главы указаны по сохранённым местам.</p>}</div>;
}
function Comparison({ preview }: { preview: Preview }) {
 const bookId = preview.choice.position.bookId;
 return <><Place title="Выбранное место устройства" position={preview.choice.position} bookId={bookId} /><Place title="Сохранённое место аккаунта" position={preview.remote} bookId={bookId} /></>;
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
 return <div className="section"><h3>Места чтения аккаунта</h3>{!preview && !download && error && <p className="description" role="alert">{error}</p>}{pending?.map(saved => <div className="section" key={saved.bookId}><p className="description">{catalog.find(b => b.id === saved.bookId)?.title ?? saved.bookId}: {saved.conflict ? 'место аккаунта изменилось — нужно сравнить заново.' : 'сохранение не подтверждено. Можно повторить тот же выбор.'}</p><button className="secondary" disabled={busy} onClick={() => { setPreview({ choice: saved.choice, remote: saved.remote }); setConflict(saved.conflict); setError(''); }}>Открыть незавершённое сохранение</button></div>)}{query.isPending || localLoading ? <p className="description" role="status">Загружаем места чтения…</p> : query.isError ? <><p className="description" role="status">{query.error.message}</p><button className="text-button" onClick={() => void query.refetch()}>Повторить загрузку</button></> : ids.length ? ids.map(id => {
  const device = local?.find(p => p.bookId === id); const remote = query.data.positions.find(p => p.bookId === id);
  return <div className="section" key={id}><h3>{catalog.find(b => b.id === id)?.title ?? id}</h3><p className="description">{accountPositions?.some(p => p.bookId === id) ? 'Аккаунт на устройстве' : 'Гостевое устройство'}: {device ? `глава ${device.chapter + 1}` : 'нет места'} · аккаунт: {remote ? `глава ${remote.chapter + 1}` : 'нет места'}</p>{device && (samePosition(device, remote) ? <p className="reader-note">Сохранённые места совпадают.</p> : <button className="secondary section" disabled={busy || query.isFetching || !pending || pending.some(saved => saved.bookId === id)} onClick={() => { setPreview({ choice: positionChoice(device, remote), remote }); setError(''); setConflict(false); }}>Сравнить и сохранить</button>)}{remote && <button className="secondary section" disabled={busy || query.isFetching || !pending || pending.some(saved => saved.bookId === id)} onClick={() => void reviewDownload(remote)}>Сравнить и принять место на устройство</button>}{catalog.some(book => book.id === id) && <Link className="secondary section" to="/account/read/$bookId" params={{ bookId: id }}>Открыть в читалке аккаунта</Link>}</div>;
 }) : <p className="description">Открой книгу — на устройстве появится место для сохранения.</p>}<p className="reader-note section">Перенос выполняется по твоему выбору. Читалка аккаунта использует отдельные места и закладки. Гостевое чтение остаётся отдельно. Сохранение места не отмечает книгу прочитанной.</p>{download && <Modal title="Принять место аккаунта?" close={() => { if (!busy) setDownload(null); }}><p className="description account-email">Аккаунт: {session.user.email}</p><h3>{catalog.find(book => book.id === download.remote.bookId)?.title ?? download.remote.bookId}</h3><Place title="Аккаунт на устройстве" position={download.local} bookId={download.remote.bookId} /><Place title="Выбранное место аккаунта" position={download.remote} bookId={download.remote.bookId} /><p className="description section">Выбранное место заменит место этого аккаунта на устройстве. Прежний вариант останется в локальной истории, а показанные изменения места больше не будут ожидать отправки. Серверное место, гостевое чтение, закладки и время не изменятся.</p><p className="description" role="alert">{error}</p><button className="primary section" disabled={busy} aria-busy={busy} onClick={() => void acceptDownload()}>{busy ? 'Принимаем…' : 'Принять место на устройство'}</button><button className="secondary section" disabled={busy} onClick={() => setDownload(null)}>Закрыть</button></Modal>}{preview && <Modal title="Какое место оставить в аккаунте?" close={() => { if (!busy) setPreview(null); }}><p className="description account-email">Аккаунт: {session.user.email}</p><Comparison preview={preview} /><p className="description">При сохранении выбранное место устройства заменит место аккаунта. Прежний вариант аккаунта останется в истории. Место на устройстве не изменится.</p><p className="description" role="alert">{error}</p><button className="primary section" disabled={busy || conflict} aria-busy={busy} onClick={() => void save()}>{busy ? 'Сохраняем…' : 'Сохранить выбранное место в аккаунте'}</button><button className="secondary section" disabled={busy} onClick={() => setPreview(null)}>Закрыть</button>{pending?.some(saved => saved.choice.operationId === preview.choice.operationId) && <><p className="description section">Выбор сохранён на устройстве. Повтор отправит то же место, даже если ты продолжил чтение. Отмена не откатывает уже принятое сервером сохранение; перед новым выбором места будут загружены снова.</p><button className="text-button section" disabled={busy} onClick={() => void discard()}>{conflict ? 'Отменить этот выбор и сравнить заново' : 'Отменить дальнейшие повторы'}</button></>}</Modal>}</div>;
}
