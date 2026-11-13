import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useAccount } from '../lib/auth';
import { useApp } from '../lib/context';
export function AccountPanel() {
 const account = useAccount(); const { act } = useApp(); const [busy, setBusy] = useState(false);
 async function logout(all: boolean) { setBusy(true); await act(() => account.logout(all), all ? 'Все сессии завершены' : 'Ты вышел из аккаунта'); setBusy(false); }
 return <section className="activity section" aria-labelledby="account-title"><h3 id="account-title">Аккаунт</h3>{account.checking ? <p className="description" role="status">Проверяем вход…</p> : account.session ? <><p className="description account-email">{account.session.user.email}</p><button className="secondary" disabled={busy} onClick={() => void logout(false)}>Выйти</button><button className="text-button section" disabled={busy} onClick={() => void logout(true)}>Выйти на всех устройствах</button></> : <><p className="description">{account.error ? 'Сервис входа сейчас недоступен. Локальное чтение остаётся доступным.' : 'Войди по почте без пароля.'}</p><Link className="secondary" to="/login">Войти или создать аккаунт</Link></>}<p className="reader-note section">Полка и прогресс — в гостевом хранилище устройства. Синхронизация ещё не подключена.</p></section>;
}
