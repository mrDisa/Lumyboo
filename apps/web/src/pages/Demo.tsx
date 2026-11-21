import { appHref, assetUrl, routeSearch } from '../lib/hosting';
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/ui';
import { verifiedResponse, type BookContent } from '../lib/books';
import { coverUrl, showcase } from '../lib/showcase';
import styles from './Demo.module.css';
export function Demo() {
 const requested = routeSearch().get('book');
 const [book, setBook] = useState(showcase.find(b => b.id === requested) ?? showcase.find(b => b.id === 'what-men-live-by') ?? showcase[0]);
 const [page, setPage] = useState<'home' | 'catalog' | 'reader'>(requested ? 'reader' : 'home');
 const [content, setContent] = useState<BookContent | null>(null);
 const [chapter, setChapter] = useState(0);
 const [size, setSize] = useState(18);
 const [goal, setGoal] = useState(20);
 const [query, setQuery] = useState('');
 const [dark, setDark] = useState(true);
 const [fontControls, setFontControls] = useState(false);
 const [bookmarks, setBookmarks] = useState<Set<string>>(new Set());
 const [error, setError] = useState('');
 const [retry, setRetry] = useState(0);
 const [notice, setNotice] = useState('');
 const cache = useRef(new Map<string, BookContent>());
 const screen = useRef<HTMLDivElement>(null);
 useEffect(() => { const before = document.documentElement.dataset.theme; document.documentElement.dataset.theme = dark ? 'dark' : 'light'; return () => { document.documentElement.dataset.theme = before; }; }, [dark]);
 useEffect(() => { screen.current?.scrollTo(0, 0); }, [page, chapter, book.id]);
 useEffect(() => {
  if (page !== 'reader') return;
  const cached = cache.current.get(book.id);
  setContent(cached ?? null); setError('');
  if (cached) return;
  const controller = new AbortController();
  void fetch(assetUrl(book.url), { signal: controller.signal }).then(response => verifiedResponse(book, response)).then(response => response.json() as Promise<BookContent>).then(value => { if (!controller.signal.aborted) { cache.current.set(book.id, value); setContent(value); } }).catch(() => { if (!controller.signal.aborted) setError('Не получилось открыть книгу. Попробуй ещё раз.'); });
  return () => controller.abort();
 }, [book, page, retry]);
 useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 2500); return () => clearTimeout(timer); }, [notice]);
 function open(id: string) { const selected = showcase.find(b => b.id === id); if (selected) { if (selected.id !== book.id) setChapter(0); setBook(selected); setPage('reader'); } }
 const key = `${book.id}:${chapter}`;
 const current = content?.id === book.id ? content.chapters[chapter] : undefined;
 const embedded = window.self !== window.top;
 return <div className={`${styles.demo} ${embedded ? styles.embedded : ''}`}>
  {!embedded && <a className={styles.back} href={appHref('/')}>На сайт Lumyboo</a>}
  <div className={`phone ${styles.phone}`}>
   <div className={`screen ${styles.screen}`} ref={screen}>
    {page !== 'reader' && <header className="topbar"><span className="brand">lumyboo<span>✳</span></span><span className={styles.badge}>Демо</span><button className="circle" aria-label="Переключить тему демо" onClick={() => setDark(!dark)}><Icon name={dark ? 'sun' : 'moon'} /></button></header>}
    {page === 'home' && <>
     <p className="greeting">Твоё время для себя</p><div className="headline"><h1>Между строк —<br /><em>целый мир.</em></h1></div>
     <div className="book-hero"><div className="hero-meta">ТВОЯ СЛЕДУЮЩАЯ ИСТОРИЯ</div><div className="book-object"><img className="cover" src={coverUrl(book.cover)} alt={`Печатное издание: ${book.title}`} /></div><div className="hero-aside"><Icon name="books" /><p>Одна глава.<br />В своём ритме.</p></div><div className="bottom-caption"><div><h3>{book.title}</h3><small>{book.author}</small></div><span className="tag">Полный текст</span></div></div>
     <button className="primary" onClick={() => open(book.id)}>Читать книгу<Icon name="books" /></button>
     <section className={styles.goal}><span className={styles.goalIcon}>✳</span><div><span className="eyebrow">Маленькая привычка</span><h2>{goal} минут для себя.</h2><p>Выбери удобный ритм чтения.</p></div><select aria-label="Дневная цель в демо" value={goal} onChange={event => setGoal(Number(event.target.value))}>{[5, 10, 20, 30, 60].map(value => <option key={value} value={value}>{value} мин</option>)}</select></section>
     <div className="section-head"><h3>С чего начнём?</h3><button className="text-button" onClick={() => setPage('catalog')}>Все книги</button></div>
     <div className="book-grid">{showcase.filter(b => b.id !== book.id).slice(0, 2).map(b => <button className="book-card" key={b.id} onClick={() => open(b.id)}><img className="cover" src={coverUrl(b.cover)} alt={`Печатное издание: ${b.title}`} /><h3>{b.title}</h3><p>{b.author}</p></button>)}</div>
    </>}
    {page === 'catalog' && <><div className="headline"><h1>Найди свою<br /><em>историю.</em></h1></div><label className={styles.search}>Поиск в демо<input value={query} onChange={event => setQuery(event.target.value)} placeholder="Название или автор" /></label><div className="book-grid">{showcase.filter(b => `${b.title} ${b.author}`.toLowerCase().includes(query.toLowerCase())).map(b => <button className="book-card" key={b.id} onClick={() => open(b.id)}><img className="cover" src={coverUrl(b.cover)} alt={`Печатное издание: ${b.title}`} /><h3>{b.title}</h3><p>{b.author}</p><p>Полный текст</p></button>)}</div>{!showcase.some(b => `${b.title} ${b.author}`.toLowerCase().includes(query.toLowerCase())) && <p className={styles.empty}>Попробуй другое название или имя автора.</p>}</>}
    {page === 'reader' && <>
     <header className={styles.readerHead}><button className="circle" aria-label="Закрыть демо-читалку" onClick={() => setPage('home')}><Icon name="close" /></button><div><strong>{book.title}</strong><small>{book.author}</small></div><button className="circle" aria-label="Настройки шрифта демо" aria-expanded={fontControls} onClick={() => setFontControls(!fontControls)}>Aa</button><button className={`circle ${bookmarks.has(key) ? styles.saved : ''}`} aria-label="Закладка в демо" aria-pressed={bookmarks.has(key)} onClick={() => { setBookmarks(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; }); setNotice(bookmarks.has(key) ? 'Закладка убрана' : 'Закладка добавлена в демо'); }}><Icon name="bookmark" /></button></header>
     {fontControls && <div className={styles.fontPanel}><label>Размер текста <output>{size} px</output><input aria-label="Размер текста демо" type="range" min={14} max={28} value={size} onChange={event => setSize(Number(event.target.value))} /></label><button className="secondary" onClick={() => setDark(!dark)}>{dark ? 'Светлая тема' : 'Тёмная тема'}</button></div>}
     {content && <label className={styles.contents}>Оглавление<select aria-label="Глава в демо" value={chapter} onChange={event => setChapter(Number(event.target.value))}>{content.chapters.map((c, index) => <option value={index} key={c.id}>{c.title}</option>)}</select></label>}
     {error ? <div className={styles.empty} role="alert"><p>{error}</p><button className="secondary" onClick={() => setRetry(retry + 1)}>Повторить</button></div> : !current ? <p role="status">Открываем книгу…</p> : <><article className={styles.reading} style={{ fontSize: size }}><span className="eyebrow">Полный текст · {chapter + 1} / {content!.chapters.length}</span><h1>{current.title}</h1>{current.paragraphs.map(p => <p key={p.id}>{p.text}</p>)}</article><div className={styles.chapterNav}><button className="secondary" disabled={chapter === 0} onClick={() => setChapter(chapter - 1)}>Назад</button><button className="secondary" disabled={chapter === content!.chapters.length - 1} onClick={() => setChapter(chapter + 1)}>Дальше</button></div><p className={styles.caption}>Это демо: главы, шрифт и закладки можно пробовать свободно. После перезагрузки они сбросятся.</p><a className="primary" href={appHref('/app')} target="_top">Открыть приложение</a></>}
    </>}
   </div>
   {page !== 'reader' && <nav className={`bottom-nav ${styles.nav}`} aria-label="Меню демо"><button aria-current={page === 'home' ? 'page' : undefined} onClick={() => setPage('home')}><Icon name="home" /><span>Главная</span></button><button aria-current={page === 'catalog' ? 'page' : undefined} onClick={() => setPage('catalog')}><Icon name="books" /><span>Каталог</span></button><a href={appHref('/app')} target="_top"><Icon name="profile" /><span>Приложение</span></a></nav>}
   {notice && <div className="toast" role="status">{notice}</div>}
  </div>
 </div>;
}
