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
import { OfflineStatus } from '../components/OfflineStatus';
export function SettingsPage() {
  const { settings, act } = useApp(); const [name, setName] = useState(settings.name);
  const [storage, setStorage] = useState('');
  return <><h1>В своём ритме.</h1><label className="field-label" htmlFor="name">Как к тебе обращаться?</label><input id="name" maxLength={60} value={name} onChange={e => setName(e.target.value)} autoComplete="nickname" /><button className="secondary section" onClick={() => void act(() => setSettings({ name: name.trim() }), 'Имя сохранено')}>Сохранить имя</button><label className="field-label">Оформление</label><div className="choice-row">{(['light', 'dark', 'system'] as const).map((theme, i) => <button className={`pill ${settings.theme === theme ? 'active' : ''}`} key={theme} aria-pressed={settings.theme === theme} onClick={() => void act(() => setSettings({ theme }))}>{['Blanc', 'Noir', 'Авто'][i]}</button>)}</div><OfflineStatus /><div className="rule" /><h3>Данные на устройстве</h3><p className="description">Полка, позиции и закладки хранятся в этом браузере. Вход доступен в профиле. После входа в профиле можно скопировать книги в аккаунт. Закладки можно скопировать отдельно. Место чтения можно сравнить с аккаунтом и сохранить отдельно.</p><button className="secondary" onClick={() => void act(async () => { const estimate = await navigator.storage?.estimate?.(); setStorage(estimate ? `Используется ${((estimate.usage ?? 0) / 1024 / 1024).toFixed(1)} МБ из ${Math.round((estimate.quota ?? 0) / 1024 / 1024)} МБ доступного хранилища сайта.` : 'Браузер не сообщает объём хранилища.'); })}>Проверить хранилище</button><p className="description" role="status">{storage}</p><Link className="secondary" to="/onboarding">Посмотреть знакомство</Link><p className="description">Установка: в Chrome используй меню «Установить приложение». На iPhone — Safari → «Поделиться» → «На экран Домой». Для офлайна сначала открой приложение по сети и скачай нужный текст.</p><p className="reader-note">Локальный пилот · бесплатно · без внешней аналитики</p></>;
}
export function Profile() {
  const { settings } = useApp();
  const data = useLiveQuery(async () => ({ shelf: await db.shelf.toArray() }));
  return <><div className="profile-identity"><div className="profile-avatar"><Sculpture /></div><h1>{settings.name || 'Твоя история'}</h1><p>Гостевой профиль этого устройства</p></div><AccountPanel /><div className="level section"><span className="eyebrow">Твой читательский путь</span><h2 className="section">Страница за страницей.</h2><p className="section">Каждая минута остаётся с тобой.</p></div><GuestReadingTime /><div className="section-head section"><h3>На твоей полке</h3><Link to="/catalog" className="text-button">В каталог ↗</Link></div><div className="book-grid">{books.filter(b => data?.shelf.some(s => s.bookId === b.id)).map(b => <BookCard key={b.id} book={b} />)}</div>{!data?.shelf.length && <Empty>Сохрани первую книгу из каталога.</Empty>}<Link to="/settings" className="secondary section">Настроить своё пространство</Link></>;
}
export { Challenges as Together } from '../components/Challenges';
export function Onboarding() {
  const { act } = useApp(); const navigate = useNavigate();
  async function finish() { if (await act(() => setSettings({ onboarded: true }))) await navigate({ to: '/catalog' }); }
  return <div className="onboarding"><div className="onboard-art"><Sculpture /><span className="art-caption">БОЛЬШЕ ИСТОРИЙ ВНУТРИ ↗</span></div><span className="eyebrow muted">Личное. Книжное. Твоё.</span><h1 className="section">Открывай книги.<br /><em>Находи себя.</em></h1><p>Истории, которые остаются с тобой. В своём ритме, без обязательной анкеты.</p><p className="section">Это первая локальная версия. Попробуй тестовую книгу, сохрани закладку и скачай её для чтения без сети.</p><div className="onboard-actions"><button className="primary" onClick={() => void finish()}>Найти свою историю<Icon name="arrow" /></button><p className="reader-note section">Без регистрации. Бесплатно.</p></div></div>;
}
