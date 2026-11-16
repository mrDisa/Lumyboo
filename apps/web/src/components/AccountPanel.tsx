import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useAccount } from '../lib/auth';
import { useApp } from '../lib/context';
import { AccountShelf } from './AccountShelf';
import { AccountBookmarkChanges } from './AccountBookmarkChanges';
import { AccountBookmarks } from './AccountBookmarks';
import { AccountPositions } from './AccountPositions';
import { AccountReadingTime } from './AccountReadingTime';
import { AccountReadingCoverage } from './AccountReadingCoverage';
import { AccountSaveStatus } from './AccountSaveStatus';
import { accountDatabase } from '../lib/account-reading';
import { LocalAccountReading } from './LocalAccountReading';
import { Modal } from './ui';
import { DailyGoalCard } from './DailyGoal';
import { ProfileSection } from './ProfileSection';
export function AccountPanel() {
 const account = useAccount(); const { act } = useApp(); const [busy, setBusy] = useState(false);
 const [pendingLogout, setPendingLogout] = useState<{ all: boolean; id: string } | null>(null);
 async function logout(all: boolean, confirmed = false) {
  const id = account.session?.user.id; if (!id || busy) return;
  setBusy(true);
  await act(async () => {
   if (!confirmed && (await accountDatabase(id).outbox.count() || await accountDatabase(id).positionChoices.count() || await accountDatabase(id).bookmarkChoices.count())) { setPendingLogout({ all, id }); return; }
   await account.logout(all, id); setPendingLogout(null);
  });
  setBusy(false);
 }
 return <section className="account-panel section" aria-labelledby="account-title">
  <div className="account-heading"><div><span className="eyebrow">Личное пространство</span><h3 id="account-title">{account.session ? 'Твой аккаунт' : account.localAccount ? 'Аккаунт на устройстве' : 'Читай с любого устройства'}</h3></div><span className="account-mode">{account.checking ? '…' : account.session ? 'Вход выполнен' : account.localAccount ? 'Без сети' : 'Гость'}</span></div>
  {account.checking ? <p className="description" role="status">Проверяем вход…</p> : account.session ? <>
   <p className="description account-email">{account.session.user.email}</p>
   <DailyGoalCard key={`goal:${account.session.user.id}`} store={accountDatabase(account.session.user.id)} />
   <AccountSaveStatus key={`save-status:${account.session.user.id}`} accountId={account.session.user.id} />
   <div className="profile-sections" key={account.session.user.id}>
    <ProfileSection title="Книги аккаунта" description="Продолжить чтение · перенести гостевую полку" icon="books"><AccountShelf session={account.session} /></ProfileSection>
    <ProfileSection title="Время и история" description="Отправка минут · записи с устройств" icon="clock"><AccountReadingTime session={account.session} /></ProfileSection>
    <ProfileSection title="Места и закладки" description="Сравнить · сохранить · восстановить" icon="bookmark"><AccountBookmarks session={account.session} /><AccountBookmarkChanges session={account.session} /><AccountPositions session={account.session} /></ProfileSection>
    <ProfileSection title="Прочитанные фрагменты" description="Отправить или получить участки текста" icon="books"><AccountReadingCoverage session={account.session} /></ProfileSection>
    <ProfileSection title="Управление аккаунтом" description="Выход на этом или всех устройствах" icon="settings">
     <button className="secondary section" disabled={busy} onClick={() => void logout(false)}>Выйти</button><button className="text-button section" disabled={busy} onClick={() => void logout(true)}>Выйти на всех устройствах</button>
    </ProfileSection>
   </div>
   {pendingLogout?.id === account.session.user.id && <Modal title="Выйти из аккаунта?" close={() => { if (!busy) setPendingLogout(null); }}><p className="description">Есть изменения чтения, сохранённые только на этом устройстве. Они останутся в хранилище этого аккаунта и будут доступны после повторного входа. Некоторые сохранения ещё не подтверждены сервером. Их можно проверить после повторного входа.</p><button className="primary section" disabled={busy} onClick={() => void logout(pendingLogout.all, true)}>Выйти и оставить изменения на устройстве</button><button className="secondary section" disabled={busy} onClick={() => setPendingLogout(null)}>Остаться в аккаунте</button></Modal>}
  </> : account.localAccount ? <LocalAccountReading user={account.localAccount} forget={account.forgetLocal} /> : <><p className="description">{account.error ? 'Сервис входа сейчас недоступен. Локальное чтение остаётся доступным.' : 'Войди по почте, чтобы сохранять чтение в аккаунте.'}</p><Link className="primary section" to="/login">Войти по почте</Link></>}
  <details className="profile-help"><summary>Как сохраняется чтение</summary><p className="reader-note">Гостевое чтение и чтение аккаунта хранятся отдельно. Время аккаунта сохраняется автоматически при открытом приложении. Место и новые изменения закладок аккаунта сохраняются при выходе из читалки. Гостевое место и закладки переносятся по твоему выбору.</p></details>
 </section>;
}
