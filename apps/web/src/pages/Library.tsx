import { useState } from 'react';
import { Link, useParams } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import catalog from '../data/catalog.json';
import { useAccount } from '../lib/auth';
import { accountDatabase } from '../lib/account-reading';
import { db, toggleShelf } from '../lib/db';
import { type Book, downloadBook, removeDownload } from '../lib/books';
import { useApp } from '../lib/context';
import { Cover, Empty, Icon, Modal, Sculpture } from '../components/ui';
import { DailyGoalCard } from '../components/DailyGoal';
import { BookCard } from '../components/BookCard';
import styles from './Catalog.module.css';
import entry from './Entry.module.css';
export const books = catalog as Book[];
function useReadingEntry(bookId: string) {
  const account = useAccount();
  const owner = account.session?.user.id ?? account.localAccount?.id;
  const store = owner ? accountDatabase(owner) : db;
  const snapshot = useLiveQuery(async () => ({ scope: store.scope, bookId, position: await store.positions.get(bookId) }), [store, bookId]);
  // Dexie can retain the previous result while the new owner's query runs.
  const position = snapshot?.scope === store.scope && snapshot.bookId === bookId ? snapshot.position : undefined;
  return { position, store, accountMode: !!owner, checking: account.checking, unavailable: !!account.error && !owner };
}
function ReadingEntry({ entry, bookId, label }: { entry: ReturnType<typeof useReadingEntry>; bookId: string; label: string }) {
  if (entry.checking) return <button className="primary" disabled>Проверяем вход…</button>;
  if (entry.unavailable) return <Link className="primary" to="/profile">Проверить вход<Icon name="arrow" /></Link>;
  return <Link className="primary" to={entry.accountMode ? '/account/read/$bookId' : '/read/$bookId'} params={{ bookId }}>{label}<Icon name="arrow" /></Link>;
}
export function Home() {
  const { settings } = useApp();
  const current = books.find(b => b.id === settings.currentBook) ?? books.find(book => book.id === 'what-men-live-by') ?? books.find(book => book.kind === 'full') ?? books[0];
  const reading = useReadingEntry(current.id);
  const position = reading.checking || reading.unavailable ? undefined : reading.position;
  const continuing = position?.version === current.version;
  const recommendations = books.filter(book => book.kind === 'full' && book.id !== current.id).slice(0, 2);
  return <>
    <p className={`greeting ${entry.greeting}`}>Твоё время для себя{settings.name ? `, ${settings.name}` : ''}</p>
    <div className={`headline ${entry.headline}`}><h1>Между строк —<br /><em>целый мир.</em></h1><Sculpture className="spark-mini" /></div>
    <section aria-label={continuing ? 'Вернуться к книге' : 'Книга для начала'}>
      <div className="book-hero"><div className="hero-light" aria-hidden="true" /><div className="hero-meta"><span>{continuing ? 'ТВОЯ ТЕКУЩАЯ ИСТОРИЯ' : 'С ЭТОГО МОЖНО НАЧАТЬ'}</span><span className="hero-edition" aria-hidden="true">L / B</span></div><div className="book-object"><Cover id={current.cover} title={current.title} /></div><div className="hero-aside">{continuing ? <><div className="percent">{String(position.chapter + 1).padStart(2, '0')}</div><small>сохранённая глава</small></> : <><Icon name="books" /><p className={entry.invitation}>{reading.accountMode ? <>Продолжим<br />в аккаунте</> : <>Первая<br />страница ждёт</>}</p></>}</div><div className="bottom-caption"><div><h3>{current.title}</h3><small>{current.author}</small></div></div></div>
      <ReadingEntry entry={reading} bookId={current.id} label={reading.accountMode ? 'Читать в аккаунте' : continuing ? 'Продолжить чтение' : 'Начать чтение'} />
      <div className={entry.bookInfo}><span>{current.kind === 'fixture' ? 'Тестовая книга' : current.kind === 'full' ? 'Полный текст' : 'Фрагмент'}</span><Link className="text-button" to="/book/$bookId" params={{ bookId: current.id }}>О книге ↗</Link></div>
    </section>
    <>{!reading.checking && !reading.unavailable && <DailyGoalCard key={reading.store.scope} store={reading.store} />}</>
    <div className="section-head"><h3>Другая история</h3><Link className="text-button" to="/catalog">В каталог ↗</Link></div>
    <div className="book-grid">{recommendations.map(book => <BookCard key={book.id} book={book} />)}</div>
  </>;

}
export function Catalog() {
  const [query, setQuery] = useState(''); const [genre, setGenre] = useState('Все'); const [shelfOnly, setShelfOnly] = useState(false);
  const shelf = useLiveQuery(() => db.shelf.toArray(), [], []);
  const list = books.filter(b => (!shelfOnly || shelf.some(s => s.bookId === b.id)) && (genre === 'Все' || b.genre === genre) && `${b.title} ${b.author}`.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru')));
  const filtered = !!query.trim() || genre !== 'Все';
  const emptyShelf = shelfOnly && shelf.length === 0;
  function resetFilters() { setQuery(''); setGenre('Все'); }
  return <>
    <h1>Найди свою<br /><em className="serif">историю.</em></h1>
    <div className="catalog-tools"><button className={`pill ${!shelfOnly ? 'active' : ''}`} aria-pressed={!shelfOnly} onClick={() => setShelfOnly(false)}>Открывай</button><button className={`pill ${shelfOnly ? 'active' : ''}`} aria-pressed={shelfOnly} onClick={() => setShelfOnly(true)}>Моя полка · {shelf.length}</button></div>
    <div className={`search-wrap ${styles.search}`}><Icon name="search" /><input type="search" aria-label="Поиск книг" placeholder="Книга или автор" value={query} onChange={e => setQuery(e.target.value)} />{query && <button className={styles.clear} aria-label="Очистить поиск" onClick={() => setQuery('')}><Icon name="close" /></button>}</div>
    <Link className={`text-button ${styles.downloads}`} to="/downloads"><Icon name="books" />Скачанные книги<Icon name="arrow" /></Link>
    <div className="filter-row" aria-label="Жанры">{['Все', ...new Set(books.map(b => b.genre))].map(g => <button className={`pill ${genre === g ? 'active' : ''}`} aria-pressed={genre === g} key={g} onClick={() => setGenre(g)}>{g}</button>)}</div>
    <section className={styles.results} aria-label="Результаты поиска">
      <div className={styles.heading}><div><span className="eyebrow muted">{shelfOnly ? 'На этом устройстве' : filtered ? 'По твоему запросу' : 'Открой новую историю'}</span><h2>{shelfOnly ? 'Твоя полка' : filtered ? 'Найдено' : 'Библиотека'}</h2></div><div className={styles.count} role="status" aria-live="polite" aria-atomic="true"><strong>{list.length}</strong><span>{list.length % 10 === 1 && list.length % 100 !== 11 ? 'книга' : [2, 3, 4].includes(list.length % 10) && ![12, 13, 14].includes(list.length % 100) ? 'книги' : 'книг'}</span></div></div>
      {filtered && <div className={styles.selection}><span>{genre === 'Все' ? 'Все жанры' : genre}{query.trim() && ` · «${query.trim()}»`}</span><button className="text-button" onClick={resetFilters}>Сбросить фильтры</button></div>}
      {list.length > 0 ? <div className="book-grid">{list.map(b => <BookCard key={b.id} book={b} />)}</div> : <div className={styles.empty}><span className={styles.emptyIcon}><Icon name={emptyShelf ? 'books' : 'search'} /></span><h3>{emptyShelf ? 'Место для любимых историй' : 'Пока без совпадений'}</h3><p>{emptyShelf ? 'Открой книгу и добавь её на полку — она появится здесь.' : 'Попробуй другое название, автора или убери фильтры.'}</p><button className="primary" onClick={() => { resetFilters(); if (emptyShelf) setShelfOnly(false); }}>{emptyShelf ? 'Выбрать книгу' : 'Сбросить фильтры'}<Icon name="arrow" /></button></div>}
    </section>
  </>;

}
export function BookDetail() {
  const { bookId } = useParams({ strict: false }); const book = books.find(b => b.id === bookId);
  const reading = useReadingEntry(bookId ?? '');
  const position = reading.checking || reading.unavailable ? undefined : reading.position;
  const continuing = !!book && position?.version === book.version;
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
      <ReadingEntry entry={reading} bookId={book.id} label={reading.accountMode ? 'Читать в аккаунте' : continuing ? 'Продолжить чтение' : 'Читать'} />
      {continuing && <p className="book-resume" role="status">{reading.accountMode ? 'Место аккаунта на устройстве' : 'Гостевое место на устройстве'} · глава {position.chapter + 1}</p>}
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
