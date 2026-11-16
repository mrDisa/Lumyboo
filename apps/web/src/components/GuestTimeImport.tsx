import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { AccountSession } from '../lib/auth';
import type { LocalDatabase } from '../lib/db';
import { cancelGuestTimeImport, importGuestTime, previewGuestTime, type TimeImportPreview } from '../lib/guest-time-import';
import { readingDuration } from '../lib/reading-session-history';
import { useApp } from '../lib/context';
import { Modal } from './ui';

export function GuestTimeImport({ store, session }: { store: LocalDatabase; session: AccountSession }) {
 const { notify } = useApp();
 const pending = useLiveQuery(() => store.guestTimeImports.get('local'), [store]);
 const [preview, setPreview] = useState<TimeImportPreview>();
 const [selected, setSelected] = useState<string[]>([]);
 const [busy, setBusy] = useState(false);
 const [error, setError] = useState('');
 async function run(action: () => Promise<void>) {
  if (busy) return;
  setBusy(true); setError('');
  try { await action(); }
  catch (error) { setError(error instanceof Error ? error.message : 'Не удалось перенести время. Повтори действие.'); }
  finally { setBusy(false); }
 }
 async function copy(retry = false) {
  await run(async () => {
   const remaining = await importGuestTime(store, retry ? undefined : { preview: preview!, days: selected });
   setPreview(undefined);
   notify(remaining ? `Часть времени сохранена. Осталось записей: ${remaining}` : 'Гостевое время сохранено в аккаунте');
  });
 }
 const chosen = preview?.days.filter(row => selected.includes(row.day)) ?? [];
 const chosenTime = chosen.reduce((sum, row) => sum + row.milliseconds, 0);
 return <div className="section">
  <button className="secondary" disabled={busy || !!pending} onClick={() => void run(async () => { setPreview(await previewGuestTime(store)); setSelected([]); })}>Перенести гостевое время</button>
  {pending && <div className="transfer-result" role="status"><p className="eyebrow">Перенос не завершён</p><div className="reading-session-result"><strong>{pending.entries.length}</strong><span>записей осталось</span></div><p className="transfer-caption">Продолжим прежний выбор без удвоения</p><button className="primary section" disabled={busy} onClick={() => void copy(true)}>Продолжить перенос времени</button><details className="day-details section"><summary>Остановить перенос</summary><p className="description">Уже принятое время останется в аккаунте.</p><button className="text-button section" disabled={busy} onClick={() => void run(async () => { await cancelGuestTimeImport(store); setPreview(undefined); })}>Отменить дальнейшие повторы</button></details></div>}
  {error && !preview && <p className="description" role="alert">{error}</p>}
  {preview && <Modal title="Перенести гостевое время?" close={() => { if (!busy) setPreview(undefined); }}>
   <p className="description account-email">Аккаунт: {session.user.email}</p>
   <div className="transfer-result" role="status" aria-live="polite">
    <p className="eyebrow">Выбрано для переноса · {chosen.length} дн.</p>
    <div className="reading-session-result"><strong>{chosenTime ? readingDuration(chosenTime) : '0 мин'}</strong><span>гостевого времени</span></div>
    <p className="transfer-caption">Выполнение дней — по целям аккаунта</p>
   </div>
   {preview.guestZone !== preview.account.goal.timeZone && <p className="transfer-notice">Часовые пояса различаются. Даты останутся гостевыми — проверь выбранные дни.</p>}
   <fieldset className="transfer-days"><legend>Выбери дни</legend>{preview.days.length ? preview.days.map(row => <label className={`bookmark-choice transfer-choice${selected.includes(row.day) ? ' is-selected' : ''}`} key={row.day}><input type="checkbox" disabled={busy || !!pending} checked={selected.includes(row.day)} onChange={event => setSelected(previous => event.target.checked ? [...previous, row.day] : previous.filter(day => day !== row.day))} /><span>{row.day.split('-').reverse().join('.')}<strong>{readingDuration(row.milliseconds)}</strong><small>Цель аккаунта {row.accountMinutes} мин · гостя {row.guestMinutes} мин</small></span></label>) : <div className="empty">Нет гостевого времени для переноса</div>}</fieldset>
   {!!preview.localOnly && <p className="transfer-notice">Только на устройстве · {preview.localOnly} записей без полных данных об издании или устройстве.</p>}
   <details className="day-details section"><summary>Правила переноса и часовые пояса</summary>
    <p className="description">Время добавится к чтению аккаунта и будет учитываться в его серии по целям аккаунта. Уже перенесённые минуты повторно не прибавятся. Гостевое чтение останется на устройстве.</p>
    <dl className="transfer-zones"><div><dt>Гость</dt><dd>{preview.guestZone}</dd></div><div><dt>Аккаунт</dt><dd>{preview.account.goal.timeZone}</dd></div></dl>
    {preview.guestZone !== preview.account.goal.timeZone && <p className="description">Даты сохранятся как записаны у гостя: пересчитать их в другой часовой пояс нельзя. Выбирай только дни, которые хочешь учесть под этими датами.</p>}
    <p className="description">Цели и прошлое время аккаунта сохраняются. Если цели различаются, выполнение дня и серия могут отличаться от гостевых. Для другого выбора цели сначала закрой окно и перенеси гостевую цель отдельно.</p>
   </details>
   {error && <p className="description" role="alert">{error}</p>}
   {pending && <button className="primary section" disabled={busy} onClick={() => void copy(true)}>Повторить сохранённый выбор</button>}
   <button className="primary section" disabled={busy || !selected.length || !!pending} onClick={() => void copy()}>{busy ? 'Переносим…' : `Добавить время · ${chosen.length} дн.`}</button>
   <button className="secondary section" disabled={busy} onClick={() => setPreview(undefined)}>{pending ? 'Закрыть окно' : 'Оставить гостевое время отдельно'}</button>
  </Modal>}
 </div>;
}
