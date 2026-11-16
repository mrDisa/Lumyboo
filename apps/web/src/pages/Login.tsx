import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { ApiError } from '../lib/api';
import { requestCode, useAccount, type LoginChallenge } from '../lib/auth';
import { Icon } from '../components/ui';
import styles from './Login.module.css';
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
 return <><Link className="text-button" to="/profile">← Профиль</Link><div className={styles.login}>
  <ol className={styles.steps} aria-label="Шаги входа"><li aria-current={!challenge ? 'step' : undefined}><span>{challenge ? <Icon name="check" /> : '1'}</span>Почта</li><li aria-current={challenge ? 'step' : undefined}><span>2</span>Код</li></ol>
  <header className={styles.heading}><h1>{challenge ? <>Проверь<br /><em className="serif">свою почту.</em></> : <>Твоя история.<br /><em className="serif">Продолжим?</em></>}</h1><p>{challenge ? 'Введи шесть цифр из письма.' : 'Вход и регистрация по коду. Без пароля.'}</p></header>
  {!challenge ? <form className={styles.form} onSubmit={send}>
   <label htmlFor="login-email">Электронная почта</label><input ref={emailInput} id="login-email" type="email" required maxLength={254} autoComplete="email" autoCapitalize="none" spellCheck={false} value={email} disabled={busy} onChange={e => setEmail(e.target.value)} aria-describedby={error ? 'login-error' : undefined} />
   <button className="primary" type="submit" disabled={busy || wait > 0}>{busy ? 'Отправляем код…' : wait ? `Повторить через ${wait} с` : 'Получить код'}<Icon name="arrow" /></button>
  </form> : <form className={styles.form} onSubmit={verify}>
   <div className={styles.delivery}><Icon name="check" /><div><small>{challenge.delivery === 'test' ? 'Код в тестовом ящике для' : 'Письмо отправлено на'}</small><b>{email.trim()}</b></div></div>
   {challenge.delivery === 'test' && <a className="text-button" href="http://127.0.0.1:8025" target="_blank" rel="noreferrer">Открыть тестовую почту ↗</a>}
   <label htmlFor="login-code">Шестизначный код</label><input className={styles.code} ref={codeInput} id="login-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} disabled={busy} onChange={e => setCode(e.target.value.replace(/[^0-9]/g, ''))} aria-describedby={`code-hint${error ? ' login-error' : ''}`} />
   <p id="code-hint" className={styles.hint}>{expired ? 'Срок кода истёк. Запроси новый.' : 'Не сообщай код другим. Он действует 10 минут.'}</p>
   <button className="primary" type="submit" disabled={busy || code.length !== 6 || expired}>{busy ? 'Проверяем…' : 'Войти'}<Icon name="arrow" /></button>
   <button className="secondary" type="button" disabled={busy || wait > 0} onClick={() => void send()}>{wait ? `Отправить снова через ${wait} с` : 'Отправить новый код'}</button>
   <button className="text-button" type="button" disabled={busy} onClick={() => { setChallenge(null); setCode(''); setError(''); requestAnimationFrame(() => emailInput.current?.focus()); }}>Изменить почту</button>
  </form>}
  {error && <p id="login-error" role="alert" className={styles.error}>{error}</p>}
  <details className={styles.help}><summary>Что будет с гостевым чтением?</summary><p>Полка, прогресс и закладки останутся на этом устройстве. После входа в профиле можно скопировать книги и гостевые закладки в аккаунт.</p><p>Место чтения можно отдельно сравнить с аккаунтом и сохранить по своему выбору.</p></details>
 </div></>;
}
