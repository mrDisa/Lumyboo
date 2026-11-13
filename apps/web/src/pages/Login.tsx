import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { ApiError } from '../lib/api';
import { requestCode, useAccount, type LoginChallenge } from '../lib/auth';
import { Icon } from '../components/ui';
export function Login() {
 const account = useAccount(); const navigate = useNavigate();
 const [email, setEmail] = useState(''); const [code, setCode] = useState('');
 const [challenge, setChallenge] = useState<LoginChallenge | null>(null);
 const [busy, setBusy] = useState(false); const [error, setError] = useState('');
 const [retryAt, setRetryAt] = useState(0); const [expiresAt, setExpiresAt] = useState(0); const [now, setNow] = useState(Date.now());
 const codeInput = useRef<HTMLInputElement>(null); const emailInput = useRef<HTMLInputElement>(null);
 useEffect(() => { if (!retryAt && !expiresAt) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [retryAt, expiresAt]);
 function failed(error: unknown) {
  setError(error instanceof ApiError ? error.message : 'Не удалось связаться с сервером. Проверь соединение и попробуй снова.');
  if (error instanceof ApiError && error.retryAfter) setRetryAt(Date.now() + error.retryAfter * 1000);
 }
 async function send(event?: FormEvent) {
  event?.preventDefault(); if (busy || Date.now() < retryAt) return;
  setBusy(true); setError('');
  try {
   const result = await requestCode(email.trim()); const timestamp = Date.now();
   setChallenge(result); setCode(''); setNow(timestamp); setRetryAt(timestamp + result.resendAfter * 1000); setExpiresAt(timestamp + result.expiresIn * 1000);
   requestAnimationFrame(() => codeInput.current?.focus());
  } catch (error) { failed(error); }
  finally { setBusy(false); }
 }
 async function verify(event: FormEvent) {
  event.preventDefault(); if (!challenge || busy) return;
  setBusy(true); setError('');
  try { await account.verified(challenge.challengeId, code); await navigate({ to: '/profile' }); }
  catch (error) { failed(error); }
  finally { setBusy(false); }
 }
 if (account.session) return <><h1>Ты уже здесь.</h1><p className="description account-email">{account.session.user.email}</p><Link className="primary" to="/profile">К своему профилю<Icon name="arrow" /></Link></>;
 const wait = Math.max(0, Math.ceil((retryAt - now) / 1000));
 const expired = !!challenge && now >= expiresAt;
 return <><Link className="text-button" to="/profile">← Профиль</Link><p className="eyebrow muted section">Твоё книжное пространство</p><h1 className="section">Возвращайся<br /><em className="serif">к своей истории.</em></h1><p className="description">Войди или создай аккаунт по одноразовому коду. Пароль не понадобится.</p>{!challenge ? <form onSubmit={send}><label className="field-label" htmlFor="login-email">Электронная почта</label><input ref={emailInput} id="login-email" type="email" required maxLength={254} autoComplete="email" autoCapitalize="none" spellCheck={false} value={email} disabled={busy} onChange={e => setEmail(e.target.value)} aria-describedby={error ? 'login-error' : undefined} /><button className="primary section" type="submit" disabled={busy || wait > 0}>{busy ? 'Отправляем код…' : wait ? `Повторить через ${wait} с` : 'Получить код'}<Icon name="arrow" /></button></form> : <form onSubmit={verify}><p className="description account-email">{challenge.delivery === 'test' ? 'Код доступен в локальном тестовом ящике для' : 'Письмо с кодом отправлено на'} {email.trim()}.</p>{challenge.delivery === 'test' && <a className="text-button" href="http://127.0.0.1:8025" target="_blank" rel="noreferrer">Открыть тестовую почту ↗</a>}<label className="field-label" htmlFor="login-code">Шестизначный код</label><input ref={codeInput} id="login-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} disabled={busy} onChange={e => setCode(e.target.value.replace(/[^0-9]/g, ''))} aria-describedby="code-hint login-error" /><p id="code-hint" className="reader-note section">{expired ? 'Время действия кода истекло. Запроси новый.' : 'Код действует 10 минут. Не сообщай его другим.'}</p><button className="primary section" type="submit" disabled={busy || code.length !== 6 || expired}>{busy ? 'Проверяем…' : 'Войти'}<Icon name="arrow" /></button><button className="secondary section" type="button" disabled={busy || wait > 0} onClick={() => void send()}>{wait ? `Отправить снова через ${wait} с` : 'Отправить новый код'}</button><button className="text-button section" type="button" disabled={busy} onClick={() => { setChallenge(null); setCode(''); setError(''); requestAnimationFrame(() => emailInput.current?.focus()); }}>Другой email</button></form>}<p id="login-error" role="alert" className="description">{error}</p><p className="reader-note section">Полка, прогресс и закладки пока остаются в гостевом хранилище этого устройства. Вход их не переносит и не удаляет.</p></>;
}
