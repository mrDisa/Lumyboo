import { GuestTimeImport } from './GuestTimeImport';
import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { AccountSession } from '../lib/auth';
import { accountDatabase } from '../lib/account-reading';
import { readingSessionReport, sendReadingSessions } from '../lib/reading-session-sync';
import { AccountLocalReadingTime } from './LocalReadingTime';
import { AccountReadingHistory } from './AccountReadingHistory';
import { resumeAutomaticReadingTime, useAutomaticReadingTime } from './AutomaticReadingTime';
import { useApp } from '../lib/context';

export function AccountReadingTime({ session }: { session: AccountSession }) {
 const store = accountDatabase(session.user.id);
 const { notify } = useApp();
 const automatic = useAutomaticReadingTime(session.user.id);
 const [busy, setBusy] = useState(false); const [error, setError] = useState('');
 const status = useLiveQuery(async () => {
  const operations = (await store.outbox.toArray()).filter(op => op.scope === store.scope && op.change.type === 'session.put');
  const eligible = operations.filter(op => readingSessionReport(op));
  return { eligible: eligible.length, uncertain: eligible.filter(op => op.state === 'sending').length, localOnly: operations.length - eligible.length };
 }, [store]);
 async function save() {
  if (busy) return;
  setBusy(true); setError('');
  try { const sent = await sendReadingSessions(store, session); resumeAutomaticReadingTime(); notify(sent ? `Записи времени подтверждены: ${sent}` : 'Новых записей для отправки нет'); }
  catch (error) { setError(error instanceof Error ? error.message : 'Не удалось сохранить время. Попробуй ещё раз.'); }
  finally { setBusy(false); }
 }
 return <div className="section"><h3>Время чтения аккаунта</h3>{automatic && <p className="description" role={automatic.phase === 'paused' ? 'alert' : 'status'}>{automatic.message}</p>}{!status ? <p className="description" role="status">Проверяем записи времени…</p> : <><div className="transfer-result" role="status"><p className="eyebrow">Очередь времени</p><p className="transfer-count"><strong>{status.eligible}</strong> к отправке</p><p className="transfer-caption">{status.eligible ? 'Ожидают сохранения в аккаунте' : 'Новых записей для отправки нет'}</p>{!!status.uncertain && <p className="transfer-notice">Без подтверждения · {status.uncertain}. Можно повторить.</p>}{!!status.localOnly && <p className="transfer-notice">Только на устройстве · {status.localOnly}</p>}</div><button className="secondary section" disabled={busy || !status.eligible} aria-busy={busy} onClick={() => void save()}>{busy ? 'Сохраняем время…' : status.uncertain ? 'Повторить сохранение времени' : 'Сохранить время в аккаунте'}</button></>}{error && <p className="description" role="alert">{error}</p>}<details className="day-details section"><summary>Как сохраняется время</summary><p className="description">Новые записи этого аккаунта отправляются автоматически при открытом приложении и доступной сети, до 50 за один раз. Можно сохранить вручную. Записи без данных об издании или устройстве остаются в локальном учёте. Гостевые минуты переносятся по твоему выбору.</p></details><GuestTimeImport store={store} session={session} /><AccountLocalReadingTime accountId={session.user.id} showGoal={false} /><AccountReadingHistory accountId={session.user.id} /></div>;
}
