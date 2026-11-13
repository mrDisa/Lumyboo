import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { AccountSession } from '../lib/auth';
import { accountDatabase } from '../lib/account-reading';
import { readingCoverageReport, sendReadingCoverage } from '../lib/reading-coverage-sync';
import { useApp } from '../lib/context';

export function AccountReadingCoverage({ session }: { session: AccountSession }) {
 const store = accountDatabase(session.user.id); const { notify } = useApp();
 const [busy, setBusy] = useState(false); const [error, setError] = useState('');
 const request = useRef<AbortController | null>(null);
 useEffect(() => () => { request.current?.abort(); }, [store]);
 const status = useLiveQuery(() => store.transaction('r', store.coverage, store.outbox, async () => {
  const operations = (await store.outbox.toArray()).filter(op => op.scope === store.scope && op.change.type === 'coverage.put');
  const eligible = operations.filter(op => readingCoverageReport(op));
  return { eligible: eligible.length, uncertain: eligible.filter(op => op.state === 'sending').length, invalid: operations.length - eligible.length, older: (await store.coverage.toArray()).filter(row => !row.queued).length };
 }), [store]);
 async function save() {
  if (request.current) return;
  const controller = new AbortController(); request.current = controller;
  setBusy(true); setError('');
  try {
   const sent = await sendReadingCoverage(store, session, controller.signal);
   if (!controller.signal.aborted) notify(sent ? `Записи фрагментов подтверждены: ${sent}` : 'Новых фрагментов для отправки нет');
  } catch (error) {
   if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Не удалось сохранить фрагменты. Попробуй ещё раз.');
  } finally {
   if (request.current === controller) { request.current = null; if (!controller.signal.aborted) setBusy(false); }
  }
 }
 return <div className="section"><h3>Фрагменты чтения аккаунта</h3>{!status ? <p className="description" role="status">Проверяем сохранение фрагментов…</p> : <><p className="description" role="status">{status.eligible ? `Записей для отправки: ${status.eligible}.` : 'Новых записей в очереди нет.'}{status.older ? ` Ранее сохранённых абзацев для отправки: ${status.older}.` : ''}{status.uncertain ? ` Без подтверждения: ${status.uncertain}. Повтор безопасен.` : ''}</p>{!!status.invalid && <p className="description" role="alert">Некоторые записи не удалось подготовить к отправке. Они остаются на устройстве.</p>}<button className="secondary section" disabled={busy || !(status.eligible || status.older)} aria-busy={busy} onClick={() => void save()}>{busy ? 'Сохраняем фрагменты…' : status.uncertain ? 'Повторить сохранение фрагментов' : 'Сохранить фрагменты в аккаунте'}</button></>}{error && <p className="description" role="alert">{error}</p>}<p className="reader-note section">Сохраняются показанные участки текста этого аккаунта. Отправка выполняется этой кнопкой при доступной сети, до 50 записей за раз. Гостевые наблюдения хранятся отдельно.</p></div>;
}
