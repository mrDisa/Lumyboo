import { appHref } from '../lib/hosting';
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Icon } from './ui';
import styles from './AppState.module.css';

function StateCard({ label, title, children, actions }: { label: string; title: string; children: ReactNode; actions: ReactNode }) {
  return <section className={styles.card} aria-labelledby="app-state-title"><div className={styles.mark}><Icon name="books" /></div><p className={styles.label}>{label}</p><h1 id="app-state-title">{title}</h1><p className={styles.description}>{children}</p><div className={styles.actions}>{actions}</div></section>;
}

export function MissingPage() {
  return <StateCard label="Страница не найдена" title="Здесь история обрывается" actions={<><Link className="primary" to="/catalog">Выбрать книгу <Icon name="arrow" /></Link><Link className="secondary" to="/">На главную</Link></>}>Возможно, ссылка устарела или в адресе есть опечатка. Найди новую историю в каталоге.</StateCard>;
}

export function RecoveryScreen({ storage = false }: { storage?: boolean }) {
  return <div className={`stage ${styles.recovery}`}><div className="phone"><main className="screen"><a className={`brand ${styles.brand}`} href={appHref('/')}>lumyboo<span className="brand-mark">✳</span></a><StateCard label="Попробуем ещё раз" title={storage ? 'Не удалось открыть приложение' : 'Не удалось открыть экран'} actions={<><button className="primary" onClick={() => location.reload()}>Попробовать снова</button>{!storage && <a className="secondary" href={appHref('/')}>На главную</a>}</>}>{storage ? 'Проверь, разрешено ли этому сайту хранить данные в браузере, и попробуй снова.' : 'Проверь подключение к сети и попробуй снова. Или вернись на главную и выбери другой раздел.'}</StateCard><p className={styles.hint}>Не очищай данные сайта, если хочешь сохранить местное чтение и закладки.</p></main></div></div>;
}

export function OpeningScreen({ reader = false }: { reader?: boolean }) {
  return <div className={styles.loading} role="status"><Icon name="books" /><p>{reader ? 'Открываем книгу…' : 'Открываем экран…'}</p></div>;
}
