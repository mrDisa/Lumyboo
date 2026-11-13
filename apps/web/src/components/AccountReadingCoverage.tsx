import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { AccountSession } from '../lib/auth';
import { accountDatabase } from '../lib/account-reading';
import { readingCoverageReport, sendReadingCoverage } from '../lib/reading-coverage-sync';
import { receiveReadingCoverage } from '../lib/reading-coverage-download';
import { loadBook, type Book } from '../lib/books';
import catalog from '../data/catalog.json';
import { resumeAutomaticReadingCoverage, useAutomaticReadingCoverage } from './AutomaticReadingCoverage';
import { useApp } from '../lib/context';

export function AccountReadingCoverage({ session }: { session: AccountSession }) {
 const store = accountDatabase(session.user.id); const { notify } = useApp();
 const automatic = useAutomaticReadingCoverage(session.user.id);
 const [action, setAction] = useState<'send' | 'receive' | null>(null); const [error, setError] = useState('');
 const [bookId, setBookId] = useState(catalog[0].id);
 const busy = action !== null;
 const request = useRef<AbortController | null>(null);
 useEffect(() => () => { request.current?.abort(); }, [store]);
 const status = useLiveQuery(() => store.transaction('r', store.coverage, store.outbox, async () => {
  const operations = (await store.outbox.toArray()).filter(op => op.scope === store.scope && op.change.type === 'coverage.put');
  const eligible = operations.filter(op => readingCoverageReport(op));
  return { eligible: eligible.length, uncertain: eligible.filter(op => op.state === 'sending').length, invalid: operations.length - eligible.length, older: (await store.coverage.toArray()).filter(row => !row.queued).length };
 }), [store]);
 async function save(action: 'send' | 'receive') {
  if (request.current) return;
  const controller = new AbortController(); request.current = controller;
  setAction(action); setError('');
  try {
   if (action === 'send') {
    const sent = await sendReadingCoverage(store, session, controller.signal);
    if (!controller.signal.aborted) { resumeAutomaticReadingCoverage(); notify(sent ? `Записи фрагментов подтверждены: ${sent}` : 'Новых фрагментов для отправки нет'); }
   } else {
    const book = catalog.find(book => book.id === bookId)! as Book;
    const content = await loadBook(book);
    const changed = await receiveReadingCoverage(store, session, content, controller.signal);
    if (!controller.signal.aborted) notify(changed ? `Фрагменты книги дополнены на устройстве: ${changed} абз.` : 'Новых фрагментов этой книги в аккаунте нет');
   }
  } catch (error) {
   if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Не удалось обновить фрагменты. Попробуй ещё раз.');
  } finally {
   if (request.current === controller) { request.current = null; if (!controller.signal.aborted) setAction(null); }
  }
 }
 return <div className="section"><h3>Фрагменты чтения аккаунта</h3>{automatic && <p className="description" role={automatic.phase === 'paused' ? 'alert' : 'status'}>{automatic.message}</p>}{!status ? <p className="description" role="status">Проверяем сохранение фрагментов…</p> : <><p className="description" role="status">{status.eligible ? `Записей для отправки: ${status.eligible}.` : 'Новых записей в очереди нет.'}{status.older ? ` Ранее сохранённых абзацев для отправки: ${status.older}.` : ''}{status.uncertain ? ` Без подтверждения: ${status.uncertain}. Повтор безопасен.` : ''}</p>{!!status.invalid && <p className="description" role="alert">Некоторые записи не удалось подготовить к отправке. Они остаются на устройстве.</p>}<button className="secondary section" disabled={busy || !(status.eligible || status.older)} aria-busy={action === 'send'} onClick={() => void save('send')}>{action === 'send' ? 'Сохраняем фрагменты…' : status.uncertain ? 'Повторить сохранение фрагментов' : 'Сохранить фрагменты в аккаунте'}</button></>}<label className="field-label" htmlFor="coverage-book">Получить фрагменты книги</label><select id="coverage-book" value={bookId} disabled={busy} onChange={event => setBookId(event.target.value)}>{catalog.map(book => <option key={book.id} value={book.id}>{book.title}</option>)}</select><button className="secondary section" disabled={busy} aria-busy={action === 'receive'} onClick={() => void save('receive')}>{action === 'receive' ? 'Получаем фрагменты…' : 'Дополнить фрагментами из аккаунта'}</button>{error && <p className="description" role="alert">{error}</p>}<p className="reader-note section">Сохраняются показанные участки текста этого аккаунта. При доступной сети они сохраняются автоматически, пока приложение открыто. Кнопка позволяет повторить сохранение вручную. При открытии книги аккаунта её фрагменты дополняются автоматически. Здесь можно повторить получение, сохраняя местные наблюдения. Гостевые данные хранятся отдельно.</p></div>;
}
