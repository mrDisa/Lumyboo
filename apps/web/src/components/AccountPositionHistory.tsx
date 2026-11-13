import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { AccountSession } from '../lib/auth';
import { accountDatabase } from '../lib/account-reading';
import { loadBook, type Book } from '../lib/books';
import { reviewPositionRestore, restoreHistoricalPosition, type PositionRestore } from '../lib/position-history';
import { useApp } from '../lib/context';
import { Place } from './PositionPlace';
import { Modal } from './ui';
import catalog from '../data/catalog.json';

export function AccountPositionHistory({ session }: { session: AccountSession }) {
 const store = accountDatabase(session.user.id);
 const { notify } = useApp();
 const history = useLiveQuery(() => store.positionHistory.toArray(), [session.user.id]);
 const [expanded, setExpanded] = useState(false);
 const [review, setReview] = useState<PositionRestore | null>(null);
 const [busy, setBusy] = useState(false);
 const [error, setError] = useState('');
 async function compare(id: string) {
  if (busy) return;
  setBusy(true); setError('');
  try { setReview(await reviewPositionRestore(store, session.user.id, id)); }
  catch (error) { setError(error instanceof Error ? error.message : 'Не удалось открыть историю.'); }
  finally { setBusy(false); }
 }
 async function restore() {
  if (!review || busy) return;
  setBusy(true); setError('');
  try {
   const book = catalog.find(book => book.id === review.historical.bookId) as Book | undefined;
   if (!book) throw new Error('Это издание недоступно в каталоге.');
   await restoreHistoricalPosition(store, review, await loadBook(book));
   setReview(null); notify('Прежнее место восстановлено на устройстве');
  } catch (error) { setError(error instanceof Error ? error.message : 'Не удалось восстановить место.'); }
  finally { setBusy(false); }
 }
 return <div className="section"><button className="text-button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>История мест на устройстве{history ? ` (${history.length})` : ''}</button>{!review && error && <p className="description" role="alert">{error}</p>}{expanded && <>{!history ? <p role="status">Загружаем историю…</p> : !history.length ? <p className="description section">Прежние места появятся здесь после замены места на устройстве.</p> : [...history].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)).map(position => {
 const book = catalog.find(book => book.id === position.bookId);
 const available = !!book && book.version === position.version;
 return <div className="section" key={position.id}><h3>{book?.title ?? position.bookId}</h3><p className="description">Глава {position.chapter + 1} · {Math.round(position.offset * 100)}% абзаца{!available ? ' · издание недоступно' : ''}</p><button className="secondary" disabled={busy || !available} onClick={() => void compare(position.id)}>Сравнить с текущим местом</button></div>;
 })}<p className="reader-note section">История хранится только на этом устройстве для текущего аккаунта.</p></>}{review && <Modal title="Восстановить прежнее место?" close={() => { if (!busy) setReview(null); }}><p className="description account-email">Аккаунт: {session.user.email}</p><h3>{catalog.find(book => book.id === review.historical.bookId)?.title ?? review.historical.bookId}</h3><Place title="Текущее место на устройстве" position={review.local} bookId={review.historical.bookId} /><Place title="Выбранное место из истории" position={review.historical} bookId={review.historical.bookId} /><p className="description section">Выбранное место станет текущим на устройстве. Прежнее останется в истории. Для сохранения в аккаунте затем сравни места и подтверди свой выбор в профиле.</p><p className="description" role="alert">{error}</p><button className="primary section" disabled={busy} aria-busy={busy} onClick={() => void restore()}>{busy ? 'Восстанавливаем…' : 'Восстановить на устройстве'}</button><button className="secondary section" disabled={busy} onClick={() => setReview(null)}>Закрыть</button></Modal>}</div>;
}
