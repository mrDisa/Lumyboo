import { Component, Suspense, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { applyAppUpdate, getOfflineState, startOfflineShell, subscribeOffline } from './lib/pwa';
import { db, defaults, setSettings } from './lib/db';
import { AppContext } from './lib/context';
import { AutomaticReadingTime } from './components/AutomaticReadingTime';
import { Icon } from './components/ui';
import { reconcileDownloads, type Book } from './lib/books';
import catalog from './data/catalog.json';
const nav = [['/', 'Главная', 'home'], ['/catalog', 'Каталог', 'books'], ['/together', 'Вместе', 'together'], ['/profile', 'Профиль', 'profile']] as const;
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <main className="error-note"><h1>Не удалось открыть приложение</h1><p>Проверь, разрешено ли хранение данных в браузере. Существующие данные не удалены.</p><button className="primary" onClick={() => location.reload()}>Попробовать снова</button></main> : this.props.children; }
}
export function App() {
  const stored = useLiveQuery(() => db.settings.get('local'));
  const settings = { ...defaults, ...stored };
  const path = useRouterState({ select: s => s.location.pathname });
  const reading = path.startsWith('/read/') || path.startsWith('/account/read/');
  const [message, notify] = useState('');
  const [online, setOnline] = useState(navigator.onLine);
  const offline = useSyncExternalStore(subscribeOffline, getOfflineState);
  useEffect(startOfflineShell, []);
  useEffect(() => { if (message) { const timer = setTimeout(() => notify(''), 5000); return () => clearTimeout(timer); } }, [message]);
  useEffect(() => {
    const change = () => setOnline(navigator.onLine);
    window.addEventListener('online', change); window.addEventListener('offline', change);
    reconcileDownloads(catalog as Book[]).catch(() => notify('Не удалось проверить загрузки. Проверь доступ к хранилищу.'));
    return () => { window.removeEventListener('online', change); window.removeEventListener('offline', change); };
  }, []);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { const dark = settings.theme === 'dark' || settings.theme === 'system' && media.matches; document.documentElement.dataset.theme = dark ? 'dark' : 'light'; document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#101010' : '#fafafa'); };
    apply(); media.addEventListener('change', apply); return () => media.removeEventListener('change', apply);
  }, [settings.theme]);
  async function act(task: () => Promise<unknown>, success?: string) {
    try { await task(); if (success) notify(success); return true; }
    catch (error) { notify(error instanceof Error ? error.message : 'Не удалось сохранить. Попробуй ещё раз.'); return false; }
  }
  const links = <>{nav.map(([to, title, icon]) => <Link key={to} to={to} activeOptions={{ exact: true }} activeProps={{ className: 'active', 'aria-current': 'page' }} aria-label={title}><Icon name={icon} /><span>{title}</span></Link>)}</>;
  return <AppContext.Provider value={{ settings, notify, act }}><AutomaticReadingTime /><aside className="desktop"><Link to="/" className="brand">lumyboo<span className="brand-mark">✳</span></Link><h2>Хорошие книги.<br /><em>В твоём ритме.</em></h2><p>Меньше мира снаружи.<br />Больше историй внутри.</p><nav className="desk-nav" aria-label="Основная навигация">{links}<Link to="/onboarding">Знакомство ↗</Link></nav><p className="foot">ЛОКАЛЬНАЯ ВЕРСИЯ · 0.1</p></aside><div className="stage"><div className="phone"><div className={`screen ${reading ? 'reading-screen' : ''}`} id="screen" key={path}><a className="skip-link" href="#content">К содержимому</a>{!reading && <header className="topbar"><Link className="brand" to="/">lumyboo<span className="brand-mark">✳</span></Link><div className="top-actions"><button className="circle" aria-label="Переключить тему" onClick={() => void act(() => setSettings({ theme: document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' }))}><Icon name={document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon'} /></button><Link className="circle" to="/settings" aria-label="Настройки"><Icon name="settings" /></Link></div></header>}{!online && <p className="status-banner" role="status">Без сети · скачанные книги доступны</p>}<main id="content"><Suspense fallback={<p className="empty" role="status">Открываем экран…</p>}><Outlet /></Suspense></main>{offline.updateAvailable && !reading && <div className="status-banner"><p>Доступна новая версия приложения.</p><button className="secondary" disabled={offline.updating} aria-busy={offline.updating} onClick={() => void act(async () => { await db.settings.get('local'); await applyAppUpdate(); })}>{offline.updating ? 'Обновляем приложение…' : 'Обновить приложение'}</button></div>}</div>{!reading && path !== '/onboarding' && <nav className="bottom-nav" aria-label="Нижнее меню">{links}</nav>}{message && <div className="toast" role="status">{message}</div>}</div></div><aside className="notes"><div className="number">{reading ? '03' : path === '/catalog' ? '02' : path === '/together' ? '04' : path === '/profile' ? '05' : '01'} / 05</div><p>Каждая история начинается с одной страницы.</p><div className="theme-switch">{(['light', 'dark', 'system'] as const).map((theme, i) => <button key={theme} className={settings.theme === theme ? 'selected' : ''} aria-label={['Тема Blanc', 'Тема Noir', 'Системная тема'][i]} aria-pressed={settings.theme === theme} onClick={() => void act(() => setSettings({ theme }))}><Icon name={['sun', 'moon', 'monitor'][i]} /></button>)}</div></aside></AppContext.Provider>;
}
