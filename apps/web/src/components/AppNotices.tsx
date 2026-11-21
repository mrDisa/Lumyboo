import { useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { BrandMark, Icon } from './ui';
import styles from './AppNotices.module.css';

export function NetworkNotice({ online, reading }: { online: boolean; reading: boolean }) {
  if (online) return null;
  return <aside className={`${styles.network} ${reading ? styles.compact : ''}`} aria-label="Подключение">
    <div className={styles.heading}><span className={styles.dot} aria-hidden="true" /><strong role="status">Без сети</strong><Link to="/downloads">Загрузки <Icon name="arrow" /></Link></div>
    {!reading && <p>Для чтения без подключения книгу нужно скачать заранее.</p>}
  </aside>;
}

export function UpdateNotice({ available, reading, updating, onUpdate }: { available: boolean; reading: boolean; updating: boolean; onUpdate: () => Promise<void> }) {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const running = useRef(false);
  if (!available || reading) return null;
  const busy = updating || pending;
  async function update() {
    if (running.current || updating) return;
    running.current = true;
    setPending(true); setError('');
    try { await onUpdate(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось обновить приложение. Попробуй ещё раз.'); }
    finally { running.current = false; setPending(false); }
  }
  return <section className={styles.update} aria-label="Обновление приложения">
    <div className={styles.heading}><span className={styles.mark}><BrandMark /></span><div><p className="eyebrow">Lumyboo</p><h2>Новая версия</h2></div></div>
    <p className={styles.caption}>Обнови приложение, когда будет удобно. Экран перезагрузится.</p>
    <button className="primary" disabled={busy} aria-busy={busy} onClick={() => void update()}><span>{busy ? 'Обновляем…' : error ? 'Повторить обновление' : 'Обновить приложение'}</span><Icon name="arrow" /></button>
    {busy && <p className={styles.feedback} role="status">Готовим новую версию…</p>}
    {error && <p className={styles.feedback} role="alert">{error}</p>}
  </section>;
}
