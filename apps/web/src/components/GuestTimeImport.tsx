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
 return <div className="section">
  <button className="secondary" disabled={busy || !!pending} onClick={() => void run(async () => { setPreview(await previewGuestTime(store)); setSelected([]); })}>Перенести гостевое время</button>
  {pending && <><p className="description section">Перенос выбранных записей не завершён: {pending.entries.length}. Повтор сохранит прежний выбор без удвоения. Уже принятое время останется в аккаунте.</p><button className="secondary section" disabled={busy} onClick={() => void copy(true)}>Продолжить перенос времени</button><button className="text-button section" disabled={busy} onClick={() => void run(async () => { await cancelGuestTimeImport(store); setPreview(undefined); })}>Отменить дальнейшие повторы</button></>}
  {error && !preview && <p className="description" role="alert">{error}</p>}
  {preview && <Modal title="Перенести гостевое время?" close={() => { if (!busy) setPreview(undefined); }}>
   <p className="description account-email">Аккаунт: {session.user.email}</p>
   <p className="description">Выбери дни. Время добавится к чтению аккаунта и будет учитываться в его серии по целям аккаунта. Уже перенесённые минуты повторно не прибавятся. Гостевое чтение останется на устройстве.</p>
   <p className="description section">Часовой пояс гостя: {preview.guestZone}. Аккаунта: {preview.account.goal.timeZone}.{preview.guestZone !== preview.account.goal.timeZone && ' Даты сохранятся как записаны у гостя: пересчитать их в другой часовой пояс нельзя. Выбирай только дни, которые хочешь учесть под этими датами.'}</p>
   <p className="reader-note section">Цели и прошлое время аккаунта сохраняются. Если цели различаются, выполнение дня и серия могут отличаться от гостевых. Для другого выбора цели сначала закрой окно и перенеси гостевую цель отдельно.</p>
   {preview.days.length ? preview.days.map(row => <label className="bookmark-choice" key={row.day}><input type="checkbox" disabled={busy || !!pending} checked={selected.includes(row.day)} onChange={event => setSelected(previous => event.target.checked ? [...previous, row.day] : previous.filter(day => day !== row.day))} /><span>{row.day.split('-').reverse().join('.')} · {readingDuration(row.milliseconds)}<br />Цель: гость {row.guestMinutes} мин · аккаунт {row.accountMinutes} мин</span></label>) : <p className="description section">Нет гостевых записей, доступных для переноса.</p>}
   {!!preview.localOnly && <p className="description section">Останутся только на устройстве: {preview.localOnly} записей без полных данных об издании или устройстве.</p>}
   {error && <p className="description" role="alert">{error}</p>}
   {pending && <button className="primary section" disabled={busy} onClick={() => void copy(true)}>Повторить сохранённый выбор</button>}
   <button className="primary section" disabled={busy || !selected.length || !!pending} onClick={() => void copy()}>{busy ? 'Переносим…' : 'Добавить выбранное время по целям аккаунта'}</button>
   <button className="secondary section" disabled={busy} onClick={() => setPreview(undefined)}>{pending ? 'Закрыть окно' : 'Оставить гостевое время отдельно'}</button>
  </Modal>}
 </div>;
}
