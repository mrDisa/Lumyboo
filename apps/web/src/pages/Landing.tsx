import { appHref, routeSearch, staticHost } from '../lib/hosting';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Link } from '@tanstack/react-router';
import { Icon } from '../components/ui';
import { startOfflineShell } from '../lib/pwa';
import { installPrompt } from '../lib/install-prompt';
import { coverUrl, showcase, telegramLink } from '../lib/showcase';
import styles from './Landing.module.css';
const telegram = telegramLink(import.meta.env.VITE_TELEGRAM_APP_URL ?? 'https://t.me/lumyboo_bot?start=app');
function Installation({ close, installed }: { close: () => void; installed: boolean }) {
 const dialog = useRef<HTMLDialogElement>(null);
 useEffect(() => { const before = document.activeElement as HTMLElement | null; dialog.current?.showModal(); return () => { dialog.current?.close(); before?.focus(); }; }, []);
 return <dialog ref={dialog} className={styles.installDialog} aria-labelledby="install-heading" onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === dialog.current) close(); }}><button className={styles.close} aria-label="Закрыть инструкцию установки" onClick={close}><Icon name="close" /></button><span className={styles.kicker}>Lumyboo всегда рядом</span><h2 id="install-heading">{installed ? 'Твоё приложение уже установлено.' : 'Книги — на главном экране.'}</h2><p>Установи Lumyboo из браузера. Магазин приложений не понадобится.</p><div className={styles.installInstructions}><div><strong>iPhone и iPad</strong><p>Открой сайт в Safari. Нажми «Поделиться», затем «На экран “Домой”» и «Добавить».</p></div><div><strong>Android</strong><p>Открой сайт в Chrome. В меню браузера выбери «Установить приложение» или «Добавить на главный экран».</p></div><div><strong>На компьютере</strong><p>В Chrome или Edge нажми значок установки в адресной строке. В Safari на Mac выбери «Файл» → «Добавить в Dock».</p></div></div><p className={styles.fine}>Если пункта установки нет, открой сайт в обычном браузере по HTTPS. Читать можно и без установки.</p><Link to="/app" className={styles.button}>Открыть приложение</Link></dialog>;
}
export function Landing() {
 const [guide, setGuide] = useState(false);
 const [menu, setMenu] = useState(false);
 const [demoBook, setDemoBook] = useState('');
 const [demoStarted, setDemoStarted] = useState(false);
 const [dark, setDark] = useState(false);
 const [installStatus, setInstallStatus] = useState('');
 const [installing, setInstalling] = useState(false);
 const installed = useSyncExternalStore(installPrompt?.subscribe ?? (() => () => {}), installPrompt?.installed ?? (() => false), () => false);
 const demo = useRef<HTMLIFrameElement>(null);
 useEffect(startOfflineShell, []);
 useEffect(() => { const section = routeSearch().get('section'); if (section && ['main', 'about', 'books', 'demo', 'install'].includes(section)) { if (section === 'demo') setDemoStarted(true); document.getElementById(section)?.scrollIntoView(); } }, []);
 useEffect(() => { if (!menu) return; const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(false); }; window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape); }, [menu]);
 useEffect(() => { const previous = document.documentElement.dataset.theme; document.documentElement.dataset.theme = dark ? 'dark' : 'light'; document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#101010' : '#fafafa'); return () => { document.documentElement.dataset.theme = previous; }; }, [dark]);
 function tryDemo(bookId?: string) {
  if (bookId) setDemoBook(bookId);
  setDemoStarted(true); setMenu(false);
  document.getElementById('demo')?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' });
 }
 async function install() {
  setInstallStatus('');
  if (installed || !installPrompt?.available()) { setGuide(true); return; }
  setInstalling(true);
  try { const result = await installPrompt.request(); if (result === 'accepted') setInstallStatus('Подтверди установку в окне браузера.'); else if (result === 'unavailable') setGuide(true); }
  catch { setInstallStatus('Браузер не открыл установку. Воспользуйся инструкцией.'); setGuide(true); }
  finally { setInstalling(false); }
 }
 return <div className={styles.landing} onClickCapture={event => {
   if (!staticHost) return;
   const anchor = (event.target as Element).closest('a');
   const section = anchor?.href.match(/[?&]section=(main|about|books|demo|install)(?:&|$)/)?.[1];
   if (section) { event.preventDefault(); setMenu(false); if (section === 'demo') setDemoStarted(true); document.getElementById(section)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); }
  }}>
  <a className={styles.skip} href={staticHost ? appHref('/?section=main') : '#main'}>К содержимому</a>
  <header className={styles.header}>
   <a className={styles.logo} href={appHref('/')} aria-label="Lumyboo — главная">lumyboo<span aria-hidden="true">✳</span></a>
   <nav id="landing-mobile-nav" className={`${styles.navigation} ${menu ? styles.open : ''}`} aria-label="Навигация по сайту"><a href={staticHost ? appHref('/?section=about') : '#about'} onClick={() => setMenu(false)}>О приложении</a><a href={staticHost ? appHref('/?section=books') : '#books'} onClick={() => setMenu(false)}>Книги</a><a href={staticHost ? appHref('/?section=demo') : '#demo'} onClick={() => { setDemoStarted(true); setMenu(false); }}>Демо</a><a href={staticHost ? appHref('/?section=install') : '#install'} onClick={() => setMenu(false)}>Установить</a></nav>
   <div className={styles.headerActions}><button className={styles.theme} onClick={() => setDark(!dark)} aria-label={dark ? 'Светлая тема сайта' : 'Тёмная тема сайта'}><Icon name={dark ? 'sun' : 'moon'} /></button><Link className={styles.login} to="/app">Открыть приложение</Link><button className={styles.menuButton} aria-expanded={menu} aria-controls="landing-mobile-nav" aria-label="Меню сайта" onClick={() => setMenu(!menu)}><span /><span /></button></div>
  </header>
  <main id="main">
   <section className={styles.hero}>
    <div className={styles.heroCopy}><span className={styles.kicker}><span className={styles.smallStar}>✳</span> Хорошие книги. В твоём ритме.</span><h1>Меньше шума.<br />Больше <em>историй.</em></h1><p className={styles.lead}>Открой книгу. Найди несколько минут для себя. Lumyboo поможет сделать чтение частью твоего дня.</p><div className={styles.heroActions}><Link className={styles.button} to="/app">Начать читать<Icon name="books" /></Link><button className={styles.secondary} onClick={() => tryDemo()}>Попробовать демо<Icon name="monitor" /></button></div><p className={styles.heroNote}>Бесплатно · На телефоне и компьютере</p><div className={styles.heroFootnote}><span aria-hidden="true">[ l / b ]</span><p>Твоя следующая история<br />начинается с одной страницы.</p></div></div>
    <div id="demo" className={styles.demoColumn}>
     <div className={styles.demoHeading}><span className={styles.kicker}>Попробуй прямо здесь</span><span className={styles.demoTag}>Живое демо</span></div>
     <div className={styles.demoFrame}>{demoStarted ? <iframe key={demoBook || 'home'} ref={demo} src={appHref(`/demo${demoBook ? `?book=${encodeURIComponent(demoBook)}` : ''}`)} title="Интерактивное демо Lumyboo: каталог и чтение" /> : <button className={styles.demoPoster} onClick={() => setDemoStarted(true)} aria-label="Запустить интерактивное демо Lumyboo"><div className={styles.posterTop}><span>lumyboo ✳</span><Icon name="sun" /></div><span className={styles.posterGreeting}>Твоё время для себя</span><strong>Между строк —<br /><em>целый мир.</em></strong><div className={styles.posterBook}><img src={coverUrl(showcase.find(b => b.id === 'what-men-live-by')!.cover)} alt="Печатное издание «Чем люди живы»" /><div><span>Лев Толстой</span><h2>Чем люди<br />живы</h2><small>Полный текст</small></div></div><span className={styles.posterPlay}>Открыть демо <Icon name="books" /></span><p>Выбирай книгу, листай главы,<br />меняй шрифт и ставь закладки.</p><div className={styles.posterNav} aria-hidden="true"><Icon name="home" /><Icon name="books" /><Icon name="together" /><Icon name="profile" /></div></button>}</div>
     <p className={styles.demoCaption}>Без регистрации. Действия в демо не меняют твой аккаунт.<br /><a href={appHref('/demo')} target="_blank" rel="noreferrer">Открыть демо в отдельном окне</a></p>
    </div>
   </section>
   <section id="about" className={styles.about}>
    <div className={styles.sectionIntro}><span className={styles.kicker}>Место для чтения</span><h2>Не ещё одна задача.<br /><em>Время для себя.</em></h2></div>
    <div className={styles.features}><article><Icon name="books" /><h3>Истории, к которым возвращаются</h3><p>Полные произведения с понятными источниками. Выбирай книгу по настроению и собирай свою полку.</p></article><article><Icon name="bookmark" /><h3>Твоё место между строк</h3><p>Настраивай размер текста, выбирай светлую или тёмную тему. Сохраняй место и важные страницы.</p></article><article><Icon name="together" /><h3>{staticHost ? 'Маленькая привычка. Каждый день.' : 'Маленькая привычка. Вместе.'}</h3><p>{staticHost ? 'Выбери дневную цель в минутах. Читай понемногу и следи за своим результатом дня.' : 'Выбери дневную цель в минутах и пригласи друга в челлендж. Каждый читает свою книгу.'}</p></article></div>
   </section>
   <section className={styles.manifesto}><span className={styles.manifestoStar} aria-hidden="true">✳</span><p>Иногда, чтобы вернуться к себе,<br />достаточно <em>открыть книгу.</em></p><span className={styles.kicker}>Одна глава — уже начало</span></section>
   <section id="books" className={styles.books}>
    <div className={styles.sectionHead}><div><span className={styles.kicker}>Есть с чего начать</span><h2>На полке — <em>целые миры.</em></h2></div><Link className={styles.textLink} to="/catalog">Весь каталог<Icon name="books" /></Link></div>
    <div className={styles.shelf}>{showcase.map(book => <button key={book.id} className={styles.shelfBook} onClick={() => tryDemo(book.id)} aria-label={`Попробовать читать: ${book.title}`}><div className={styles.shelfCover}><img src={coverUrl(book.cover)} alt={`Печатное издание: ${book.title}`} loading="lazy" /><span>Читать в демо</span></div><h3>{book.title}</h3><p>{book.author}</p></button>)}</div>
    <p className={styles.shelfNote}>Полные тексты. Каталог растёт — начинаем с классики.</p>
   </section>
   <section id="install" className={styles.install}>
    <div className={styles.sectionIntro}><span className={styles.kicker}>Твоя библиотека рядом</span><h2>Читай там,<br />где <em>удобно тебе.</em></h2><p>В браузере, отдельным приложением или через Telegram. Выбери свой способ.</p></div>
    <div className={styles.installChoices}>
     <article><div className={styles.installIcon}><Icon name="monitor" /></div><span className={styles.kicker}>На твоём устройстве</span><h3>Lumyboo как приложение</h3><p>Добавь значок на телефон или компьютер и открывай свою библиотеку отдельно от вкладок браузера.</p><button className={styles.button} onClick={() => void install()} disabled={installing}>{installing ? 'Открываем установку…' : installed ? 'Приложение установлено' : 'Установить приложение'}<Icon name="download" /></button><button className={styles.guideLink} onClick={() => setGuide(true)}>Как установить на моём устройстве</button></article>
     <article><div className={styles.installIcon}><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21.3 3.4 18.2 20c-.2 1-1 1.3-1.8.8l-4.7-3.5-2.3 2.2c-.3.3-.5.5-1 .5l.4-4.7 8.6-7.8c.4-.3-.1-.5-.6-.2L6.2 14 1.6 12.6c-1-.3-1-1 .2-1.5L20 3c.9-.3 1.5.2 1.3.4Z" /></svg></div><span className={styles.kicker}>Внутри мессенджера</span><h3>Lumyboo в Telegram</h3><p>Тот же мир книг — через Mini App. Вход в приложение начинается с нашего бота.</p>{telegram ? <a className={styles.secondary} href={telegram} target="_blank" rel="noopener noreferrer">Открыть бота Lumyboo<Icon name="together" /></a> : <p className={styles.fine}>Telegram-версия пока недоступна. Приложение можно открыть в браузере.</p>}<span className={styles.fine}>Без отдельного скачивания из магазина</span></article>
    </div>{installStatus && <p className={styles.installStatus} role="status">{installStatus}</p>}
   </section>
   <section className={styles.faq}><div><span className={styles.kicker}>Если хочется узнать больше</span><h2>Пара слов<br /><em>перед началом.</em></h2></div><div className={styles.questions}><details><summary>Это бесплатно?</summary><p>{staticHost ? 'Да. Доступные книги, читалка и дневная цель бесплатны.' : 'Да. Доступные книги, читалка, дневная цель и челленджи бесплатны.'}</p></details><details><summary>Нужна ли регистрация?</summary><p>{staticHost ? 'Нет. Здесь доступны интерактивное демо и гостевое чтение. Полка, место и закладки сохраняются на этом устройстве. Вход в аккаунт и челленджи в этой версии пока недоступны.' : 'Демо и гостевое чтение доступны без регистрации. Аккаунт нужен, чтобы сохранять данные чтения на сервере и участвовать в челленджах.'}</p></details><details><summary>Какие книги уже есть?</summary><p>Начинаем с русской классики: Достоевский, Толстой, Пушкин, Чехов и Гоголь. {staticHost ? 'В этой версии опубликованы полные произведения.' : 'В каталоге указано, где полный текст, а где фрагмент.'} Для каждой новой книги проверяем источник текста и изображения.</p></details><details><summary>Можно пользоваться на компьютере?</summary><p>Да. На большом экране приложение сохраняет компактный формат читалки. Попробуй его в демо выше или открой полную версию.</p></details></div></section>
   <section className={styles.finalCta}><span aria-hidden="true">✳</span><h2>Оставь немного<br />времени <em>для книги.</em></h2><Link className={styles.button} to="/app">Начать свою историю<Icon name="books" /></Link><p>Без спешки. В твоём ритме.</p></section>
  </main>
  <footer className={styles.footer}><a className={styles.logo} href={appHref('/')}>lumyboo<span aria-hidden="true">✳</span></a><p>Книги, которые остаются с тобой.</p><div><a href={staticHost ? appHref('/?section=demo') : '#demo'} onClick={() => setDemoStarted(true)}>Демо</a><Link to="/app">Приложение</Link>{telegram && <a href={telegram} target="_blank" rel="noopener noreferrer">Telegram</a>}</div><small>© {new Date().getFullYear()} Lumyboo</small></footer>
  {guide && <Installation installed={installed} close={() => setGuide(false)} />}
 </div>;
}
