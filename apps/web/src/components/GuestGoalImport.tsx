import { useState } from 'react';
import { db, type LocalDatabase } from '../lib/db';
import { ensureDailyGoal, goalDay, goalMinutes, nextGoalDay, type DailyGoal } from '../lib/daily-goal';
import { guestGoalHistory, syncAccountGoal, type GoalSnapshot } from '../lib/account-daily-goal';
import { useApp } from '../lib/context';
import { Modal } from './ui';

export function GuestGoalImport({ store, saved }: { store: LocalDatabase; saved: (value: GoalSnapshot) => void }) {
 const { act } = useApp();
 const [preview, setPreview] = useState<{ guest: DailyGoal; account: GoalSnapshot }>();
 const [busy, setBusy] = useState(false);
 const [includeHistory, setIncludeHistory] = useState(true);
 async function open() {
  setBusy(true);
  try { await act(async () => {
   const guest = await ensureDailyGoal(db);
   const account = await syncAccountGoal(store);
   setIncludeHistory(true); setPreview({ guest, account });
  }); } finally { setBusy(false); }
 }
 async function copy() {
  if (!preview || busy) return;
  setBusy(true);
  try {
   const ok = await act(async () => {
    const result = await syncAccountGoal(store, undefined, { guest: preview.guest, expectedRevision: preview.account.goal.revision, includeHistory });
    saved(result);
   }, 'Гостевая цель перенесена в аккаунт');
   if (ok) setPreview(undefined);
  } finally { setBusy(false); }
 }
 const guestMinutes = preview && goalMinutes(preview.guest, nextGoalDay(goalDay(preview.guest.timeZone)));
 const accountMinutes = preview && goalMinutes(preview.account.goal, nextGoalDay(goalDay(preview.account.goal.timeZone)));
 const history = preview ? guestGoalHistory(preview.guest, preview.account.goal) : [];
 return <><button className="text-button section" disabled={busy} onClick={() => void open()}>Перенести гостевую цель</button>{preview && <Modal title="Перенести гостевую цель?" close={() => { if (!busy) setPreview(undefined); }}>
  <p className="description">Гость: {guestMinutes} мин · {preview.guest.timeZone}. Аккаунт: {accountMinutes} мин · {preview.account.goal.timeZone}.</p>
  <p className="description section">С завтрашнего дня аккаунта установим {guestMinutes} мин. Сегодняшняя цель и уже сохранённые дни аккаунта останутся прежними.</p>
  <p className="description section">{history.length ? `Можно добавить раннюю историю гостевой цели: ${history.length} изменений до ${preview.account.goal.changes[0].from.split('-').reverse().join('.')}.` : 'История гостевой цели останется отдельно.'}{preview.guest.timeZone !== preview.account.goal.timeZone && ' Часовые пояса различаются; историю дней не объединяем.'}</p>
  {!!history.length && <label className="description section"><input type="checkbox" checked={includeHistory} disabled={busy} onChange={event => setIncludeHistory(event.target.checked)} /> Добавить раннюю историю цели</label>}
  <p className="reader-note section">Гостевые настройки и чтение сохранятся на устройстве. Этот выбор переносит цель, без гостевых минут, серии, места и закладок. Часовой пояс аккаунта сохраняется.</p>
  <button className="primary section" disabled={busy} onClick={() => void copy()}>{busy ? 'Переносим…' : 'Использовать гостевую цель'}</button>
  <button className="secondary section" disabled={busy} onClick={() => setPreview(undefined)}>Оставить цель аккаунта</button>
 </Modal>}</>;
}
