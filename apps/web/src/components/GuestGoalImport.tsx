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
  <div className="transfer-result">
   <p className="eyebrow">Цель аккаунта · с завтра</p>
   <div className="transfer-goal"><span><small>Сейчас на завтра</small>{accountMinutes}<small>минут</small></span><span aria-hidden="true">→</span><strong><small>После переноса</small>{guestMinutes}<small>минут</small></strong></div>
   <p className="transfer-caption">Сегодняшняя цель сохранится</p>
  </div>
  {!!history.length && <label className="bookmark-choice transfer-choice"><input type="checkbox" checked={includeHistory} disabled={busy} onChange={event => setIncludeHistory(event.target.checked)} /><span>Добавить раннюю историю<strong>Изменений цели: {history.length}</strong><small>До {preview.account.goal.changes[0].from.split('-').reverse().join('.')}</small></span></label>}
  {preview.guest.timeZone !== preview.account.goal.timeZone && <p className="transfer-notice">Разные часовые пояса · историю дней не объединяем</p>}
  <details className="day-details section"><summary>Что изменится при переносе</summary>
   <p className="description">С завтрашнего дня аккаунта установим {guestMinutes} мин. Сегодняшняя цель и уже сохранённые дни аккаунта останутся прежними.</p>
   {!history.length && <p className="description">История гостевой цели останется отдельно.</p>}
   <dl className="transfer-zones"><div><dt>Гость</dt><dd>{preview.guest.timeZone}</dd></div><div><dt>Аккаунт</dt><dd>{preview.account.goal.timeZone}</dd></div></dl>
   <p className="description">Гостевые настройки и чтение сохранятся на устройстве. Этот выбор переносит цель, без гостевых минут, серии, места и закладок. Часовой пояс аккаунта сохраняется.</p>
  </details>
  <button className="primary section" disabled={busy} onClick={() => void copy()}>{busy ? 'Переносим…' : 'Использовать гостевую цель'}</button>
  <button className="secondary section" disabled={busy} onClick={() => setPreview(undefined)}>Оставить цель аккаунта</button>
 </Modal>}</>;
}
