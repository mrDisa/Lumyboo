import { staticHost } from '../lib/hosting';
import { Link, useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { db, setSettings } from '../lib/db';
import { useApp } from '../lib/context';
import { GuestReadingTime } from '../components/LocalReadingTime';
import { Icon, Sculpture, Empty } from '../components/ui';
import { BookCard } from '../components/BookCard';
import { books } from './Library';
import { AccountPanel } from '../components/AccountPanel';
import { useAccount } from '../lib/auth';
import { ProfileSection } from '../components/ProfileSection';
import { OfflineStatus } from '../components/OfflineStatus';
import entry from './Entry.module.css';
export function SettingsPage() {
  const { settings, act } = useApp(); const [name, setName] = useState(settings.name);
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);
  const [storageChecked, setStorageChecked] = useState(false);
  return <><h1>В своём ритме.</h1>
    <section className="settings-appearance section" aria-labelledby="appearance-title">
      <span className="eyebrow muted">Твоё пространство</span><h2 id="appearance-title">Оформление</h2>
      <div className="theme-options">{(['light', 'dark', 'system'] as const).map((theme, i) => <button className={`theme-option ${settings.theme === theme ? 'active' : ''}`} key={theme} aria-pressed={settings.theme === theme} onClick={() => void act(() => setSettings({ theme }))}><span className={`theme-swatch theme-swatch-${theme}`} aria-hidden="true">Aa</span><strong>{['Blanc', 'Noir', 'Авто'][i]}</strong><small>{['Светлое', 'Тёмное', 'Как на устройстве'][i]}</small></button>)}</div>
    </section>
    <OfflineStatus />
    <div className="profile-sections">
      <ProfileSection title="Имя" description={settings.name || 'Как к тебе обращаться'} icon="profile">
        <label className="field-label" htmlFor="name">Как к тебе обращаться?</label><input id="name" maxLength={60} value={name} onChange={e => setName(e.target.value)} autoComplete="nickname" /><button className="secondary section" onClick={() => void act(() => setSettings({ name: name.trim() }), 'Имя сохранено')}>Сохранить имя</button>
      </ProfileSection>
      <ProfileSection title="Хранилище и данные" description="Книги и данные на устройстве" icon="books">
        <button className="secondary section" onClick={() => void act(async () => { const estimate = await navigator.storage?.estimate?.(); setStorage(estimate ? { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 } : null); setStorageChecked(true); })}>Проверить хранилище</button>
        <div role="status">{storage ? <div className="storage-result"><strong>{(storage.usage / 1024 / 1024).toFixed(1)} <small>МБ занято</small></strong><progress max={Math.max(storage.quota, storage.usage, 1)} value={storage.usage} aria-label="Использование хранилища сайта" /><p className="reader-note">Доступный объём сайта: {Math.round(storage.quota / 1024 / 1024)} МБ</p></div> : storageChecked && <p className="description section">Браузер не сообщает объём хранилища.</p>}</div>
        <p className="description section">{staticHost ? 'Полка, места, закладки и история чтения хранятся на этом устройстве. Открой профиль, чтобы посмотреть свою полку и время за книгами.' : 'Полка, места и закладки хранятся в этом браузере. В профиле можно войти, скопировать полку и закладки в аккаунт, сравнить и сохранить место чтения.'}</p><Link className="text-button" to="/profile">Открыть профиль ↗</Link>
      </ProfileSection>
      <ProfileSection title="Установить приложение" description="Читать в отдельном окне на телефоне" icon="monitor">
        <ol className="install-steps"><li><strong>Android · Chrome</strong><span>Меню → «Установить приложение».</span></li><li><strong>iPhone · Safari</strong><span>«Поделиться» → «На экран Домой».</span></li></ol>
        <p className="description">Для офлайна сначала открой приложение по сети и скачай нужные книги. Установка и офлайн требуют HTTPS или localhost.</p>
      </ProfileSection>
      <ProfileSection title="Знакомство с Lumyboo" description="Вернуться к первому экрану" icon="spark"><Link className="secondary section" to="/onboarding">Посмотреть знакомство</Link></ProfileSection>
    </div><p className="reader-note section">Бесплатно · без внешней аналитики</p></>;

}
export function Profile() {
  const { settings } = useApp();
  const account = useAccount();
  const hasAccount = !!(account.session || account.localAccount);
  const data = useLiveQuery(async () => ({ shelf: await db.shelf.toArray() }));
  const guestShelf = <><div className="section-head section"><h3>Гостевая полка</h3><Link to="/catalog" className="text-button">В каталог ↗</Link></div><div className="book-grid">{books.filter(b => data?.shelf.some(s => s.bookId === b.id)).map(b => <BookCard key={b.id} book={b} />)}</div>{!data?.shelf.length && <Empty>Сохрани первую книгу из каталога.</Empty>}</>;
  return <><div className="profile-identity"><div className="profile-avatar"><Sculpture /></div><h1>{settings.name || 'Твоя история'}</h1><p>{hasAccount ? 'Твоё пространство для чтения' : 'Гостевой профиль этого устройства'}</p></div>{!staticHost && <AccountPanel />}
   {hasAccount ? <div className="profile-sections section"><ProfileSection title="Гостевое чтение" description="Отдельные минуты, цель и полка устройства" icon="profile"><GuestReadingTime />{guestShelf}</ProfileSection></div> : !account.checking && <><GuestReadingTime />{guestShelf}</>}
   <Link to="/settings" className="secondary section">Настроить своё пространство</Link></>;

}
export { Challenges as Together } from '../components/Challenges';
export function Onboarding() {
  const { act } = useApp(); const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  async function finish() {
    if (busy) return;
    setBusy(true);
    try { if (await act(() => setSettings({ onboarded: true }))) await navigate({ to: '/catalog' }); }
    finally { setBusy(false); }
  }
  return <div className={`onboarding ${entry.onboarding}`}>
    <div className={`onboard-art ${entry.art}`}><Sculpture /><span className="art-caption">БОЛЬШЕ ИСТОРИЙ ВНУТРИ ↗</span></div>
    <span className="eyebrow muted">Личное. Книжное. Твоё.</span>
    <h1 className="section">Открывай книги.<br /><em>Находи себя.</em></h1>
    <p>Истории, которые остаются с тобой. В своём ритме, без обязательной анкеты.</p>
    <ul className={entry.features}>
      <li><Icon name="books" /><div><strong>Выбери историю</strong><span>Книги можно открыть без регистрации.</span></div></li>
      <li><Icon name="bookmark" /><div><strong>Остановись на своей строке</strong><span>Место и закладки сохраняются на устройстве.</span></div></li>
      <li><Icon name="arrow" /><div><strong>Возьми книгу с собой</strong><span>Скачай текст заранее для чтения без сети.</span></div></li>
    </ul>
    <div className="onboard-actions"><button className="primary" disabled={busy} aria-busy={busy} onClick={() => void finish()}>{busy ? 'Открываем каталог…' : 'Найти свою историю'}<Icon name="arrow" /></button><p className="reader-note section">Без регистрации. Бесплатно.</p></div>
  </div>;
}
