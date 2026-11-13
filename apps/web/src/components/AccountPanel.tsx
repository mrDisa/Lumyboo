import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useAccount } from '../lib/auth';
import { useApp } from '../lib/context';
import { AccountShelf } from './AccountShelf';
import { AccountBookmarkChanges } from './AccountBookmarkChanges';
import { AccountBookmarks } from './AccountBookmarks';
import { AccountPositions } from './AccountPositions';
import { AccountReadingTime } from './AccountReadingTime';
import { AccountSaveStatus } from './AccountSaveStatus';
import { accountDatabase } from '../lib/account-reading';
import { Modal } from './ui';
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
 return <section className="activity section" aria-labelledby="account-title"><h3 id="account-title">Аккаунт</h3>{account.checking ? <p className="description" role="status">Проверяем вход…</p> : account.session ? <><p className="description account-email">{account.session.user.email}</p><button className="secondary" disabled={busy} onClick={() => void logout(false)}>Выйти</button><button className="text-button section" disabled={busy} onClick={() => void logout(true)}>Выйти на всех устройствах</button><AccountSaveStatus key={`save-status:${account.session.user.id}`} accountId={account.session.user.id} /><AccountReadingTime key={`time:${account.session.user.id}`} session={account.session} /><AccountShelf key={account.session.user.id} session={account.session} /><AccountBookmarks key={`bookmarks:${account.session.user.id}`} session={account.session} /><AccountBookmarkChanges key={`bookmark-changes:${account.session.user.id}`} session={account.session} /><AccountPositions key={`positions:${account.session.user.id}`} session={account.session} />{pendingLogout?.id === account.session.user.id && <Modal title="Выйти из аккаунта?" close={() => { if (!busy) setPendingLogout(null); }}><p className="description">Есть изменения чтения, сохранённые только на этом устройстве. Они останутся в хранилище этого аккаунта и будут доступны после повторного входа. Некоторые сохранения ещё не подтверждены сервером. Их можно проверить после повторного входа.</p><button className="primary section" disabled={busy} onClick={() => void logout(pendingLogout.all, true)}>Выйти и оставить изменения на устройстве</button><button className="secondary section" disabled={busy} onClick={() => setPendingLogout(null)}>Остаться в аккаунте</button></Modal>}</> : <><p className="description">{account.error ? 'Сервис входа сейчас недоступен. Локальное чтение остаётся доступным.' : 'Войди по почте без пароля.'}</p><Link className="secondary" to="/login">Войти или создать аккаунт</Link></>}<p className="reader-note section">Гостевое чтение и чтение аккаунта хранятся отдельно. Время аккаунта сохраняется автоматически при открытом приложении. Места чтения и закладки сохраняются по твоему выбору.</p></section>;
}
