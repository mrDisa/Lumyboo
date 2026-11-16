import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import catalog from '../data/catalog.json';
import { db, toggleShelf } from '../lib/db';
import { type Book, downloadBook, removeDownload } from '../lib/books';
import { useApp } from '../lib/context';
import { Cover, Empty, Icon, Modal, Sculpture } from '../components/ui';
import { DailyGoalCard } from '../components/DailyGoal';
import { BookCard } from '../components/BookCard';
export const books = catalog as Book[];
export function Home() {
  const { settings } = useApp();
  const current = books.find(b => b.id === settings.currentBook) ?? books[0];
  const position = useLiveQuery(() => db.positions.get(current.id), [current.id]);
  return <><p className="greeting">Твоё время для себя{settings.name ? `, ${settings.name}` : ''}</p><div className="headline"><h1>Между строк —<br /><em>целый мир.</em></h1><Sculpture className="spark-mini" /></div><div className="book-hero"><div className="hero-light" /><div className="hero-meta"><span>01 — ТВОЯ ТЕКУЩАЯ ИСТОРИЯ</span><span className="hero-edition">L / B</span></div><div className="book-object"><Cover id={current.cover} title={current.title} /></div><div className="hero-aside"><div className="percent">{position ? String(position.chapter + 1).padStart(2, '0') : '01'}</div><small>{position ? 'текущая глава' : 'история ждёт'}</small><div className="ticks">{Array.from({ length: 16 }, (_, i) => <i key={i} />)}</div><small>в своём ритме</small></div><div className="bottom-caption"><div><h3>{current.title}</h3><small>{current.author}</small></div></div></div><Link className="primary" to="/read/$bookId" params={{ bookId: current.id }}>{position ? 'Продолжить чтение' : 'Начать чтение'}<Icon name="arrow" /></Link><p className="reader-note section">{current.kind === 'fixture' ? 'Полная тестовая книга · локальный пилот' : current.kind === 'full' ? 'Полный текст' : 'Фрагмент из прототипа'}</p><DailyGoalCard store={db} /><div className="section-head"><h3>С чего начнём?</h3><Link className="text-button" to="/catalog">В каталог ↗</Link></div><div className="book-grid">{books.slice(0, 2).map(b => <BookCard key={b.id} book={b} />)}</div><blockquote className="quote serif">«Я читаю — и целый мир<br />становится ближе».<small>ТВОЯ СЛЕДУЮЩАЯ ИСТОРИЯ ЖДЁТ</small></blockquote></>;
}
export function Catalog() {
  const [query, setQuery] = useState(''); const [genre, setGenre] = useState('Все'); const [shelfOnly, setShelfOnly] = useState(false);
  const shelf = useLiveQuery(() => db.shelf.toArray(), [], []);
  const list = books.filter(b => (!shelfOnly || shelf.some(s => s.bookId === b.id)) && (genre === 'Все' || b.genre === genre) && `${b.title} ${b.author}`.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru')));
  return <><h1>Найди свою<br /><em className="serif">историю.</em></h1><div className="catalog-tools"><button className={`pill ${!shelfOnly ? 'active' : ''}`} aria-pressed={!shelfOnly} onClick={() => setShelfOnly(false)}>Открывай</button><button className={`pill ${shelfOnly ? 'active' : ''}`} aria-pressed={shelfOnly} onClick={() => setShelfOnly(true)}>Моя полка · {shelf.length}</button></div><div className="search-wrap"><Icon name="search" /><input aria-label="Поиск книг" placeholder="Книга или автор" value={query} onChange={e => setQuery(e.target.value)} /></div><Link className="text-button downloads-link" to="/downloads"><Icon name="books" />Скачанные книги ↗</Link><div className="filter-row" aria-label="Жанры">{['Все', ...new Set(books.map(b => b.genre))].map(g => <button className={`pill ${genre === g ? 'active' : ''}`} aria-pressed={genre === g} key={g} onClick={() => setGenre(g)}>{g}</button>)}</div>{!shelfOnly && <div className="feature-banner"><span className="eyebrow">Локальная библиотека</span><h3>Небольшие книги.<br />Большое послевкусие.</h3><p>Полные рассказы и знакомство с классикой</p><Sculpture /></div>}<div className="section-head"><h3>{shelfOnly ? 'Твоя коллекция' : 'С чего начнём?'}</h3><span className="eyebrow muted">{list.length} текста</span></div><div className="book-grid">{list.map(b => <BookCard key={b.id} book={b} />)}</div>{!list.length && <Empty>{shelfOnly ? 'На полке пока нет таких книг. Добавь их из каталога.' : 'Ничего не найдено. Попробуй другое название или жанр.'}</Empty>}<p className="reader-note section">Это технический пилот. Каталог пополняется по мере проверки текстов и прав.</p></>;
}
export function BookDetail() {
  const { bookId } = useParams({ strict: false }); const book = books.find(b => b.id === bookId);
  const saved = useLiveQuery(() => db.shelf.get(bookId ?? ''), [bookId]);
  const downloaded = useLiveQuery(() => db.downloads.get(bookId ?? ''), [bookId]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [removing, setRemoving] = useState(false);
  const { act } = useApp();
  if (!book) return <Empty>Книга не найдена. <Link to="/catalog">Вернуться в каталог</Link></Empty>;
  async function download() {
    setBusy(true); setProgress(0);
    await act(() => downloadBook(book!, setProgress), 'Книга скачана. Можно читать без сети.');
    setBusy(false);
  }
  async function remove() {
    setBusy(true);
    if (await act(() => removeDownload(book!), 'Загрузка удалена. Позиция и закладки сохранены.')) setRemoving(false);
    setBusy(false);
  }
  const format = book.kind === 'fixture' ? 'Полная тестовая книга' : book.kind === 'full' ? 'Полный текст' : 'Только фрагмент';
  return <>
    <Link className="text-button" to="/catalog">← Каталог</Link>
    <article className="book-presentation section">
      <div className="book-presentation-art"><Cover id={book.cover} title={book.title} /><span className="tag">{format}</span></div>
      <div className="book-presentation-title"><span className="eyebrow muted">{book.genre} · {book.year}</span><h1>{book.title}</h1><p>{book.author}</p></div>
      <Link className="primary" to="/read/$bookId" params={{ bookId: book.id }}>Читать<Icon name="arrow" /></Link>
      <button className="secondary book-shelf" aria-pressed={!!saved} onClick={() => void act(() => toggleShelf(book.id))}><Icon name="books" />{saved ? 'На полке · убрать' : 'Добавить на полку'}</button>
    </article>
    <section className="book-about section"><h2>Об истории</h2><p className="description">{book.description}</p></section>
    <section className="book-offline section" aria-label="Загрузка книги">
      <div className="book-offline-heading"><span className="profile-section-icon"><Icon name="books" /></span><div><strong>{downloaded ? 'Текст на устройстве' : 'Возьми с собой'}</strong><small>{Math.ceil((downloaded?.bytes ?? book.bytes) / 1024)} КБ · {downloaded ? 'скачано' : 'для чтения без сети'}</small></div></div>
      {busy && !removing && <div className="book-download-progress" role="progressbar" aria-label="Загрузка и проверка текста" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div>}
      <button className="secondary section" disabled={busy} onClick={() => downloaded ? setRemoving(true) : void download()}>{busy && !removing ? `Загрузка и проверка · ${progress}%` : downloaded ? 'Удалить загрузку' : 'Скачать текст'}{!downloaded && !busy && <Icon name="arrow" />}</button>
      <p className="reader-note book-download-status" role="status">{downloaded ? 'Сохранено на устройстве' : busy ? 'Сохраняем текст…' : 'Скачай, пока есть сеть'}</p>
      <details className="goal-details"><summary>Как хранится книга</summary><p className="description">Браузер может освободить место — наличие текста проверяется при запуске. Удаление загрузки оставляет позиции и закладки на устройстве.</p></details>
    </section>
    <details className="goal-details book-edition section"><summary>Об издании и источниках</summary><p className="description">{book.rights}</p><div className="book-source-links">{book.sourceUrl && <a href={book.sourceUrl} target="_blank" rel="noreferrer">Источник текста ↗</a>}{book.licenseUrl && <a href={book.licenseUrl} target="_blank" rel="noreferrer">Условия использования ↗</a>}{book.coverSourceUrl && <a href={book.coverSourceUrl} target="_blank" rel="noreferrer">Печатное издание ↗</a>}</div></details>
    {removing && <Modal title="Удалить загрузку?" close={() => { if (!busy) setRemoving(false); }}><h3>{book.title}</h3><p className="description section">Текст придётся скачать заново. Позиция и закладки останутся на устройстве.</p><button className="primary section" disabled={busy} onClick={() => void remove()}>{busy ? 'Удаляем…' : 'Удалить загрузку'}</button><button className="secondary section" disabled={busy} onClick={() => setRemoving(false)}>Оставить книгу</button></Modal>}
  </>;
}
