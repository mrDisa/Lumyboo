import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, useParams, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useLiveQuery } from 'dexie-react-hooks';
import { books } from './Library';
import { loadBook, type BookContent } from '../lib/books';
import { db, setSettings, toggleBookmark, bookmarkId, loadPosition, type Position } from '../lib/db';
import { ReadingClock, localDay } from '../lib/reading';
import { useApp } from '../lib/context';
import { Empty, Icon, Modal } from '../components/ui';
import styles from './Reader.module.css';
export function Reader() {
  const { bookId } = useParams({ strict: false }); const book = books.find(b => b.id === bookId);
  const query = useQuery({ queryKey: ['book', bookId], queryFn: () => loadBook(book!), enabled: !!book, retry: false, staleTime: Infinity });
  if (!book) return <Empty>Книга не найдена. <Link to="/catalog">В каталог</Link></Empty>;
  if (query.isPending) return <Empty>Открываем историю…</Empty>;
  if (query.isError) return <Empty><p>{query.error.message}</p><button className="secondary section" onClick={() => void query.refetch()}>Попробовать снова</button><Link to="/book/$bookId" params={{ bookId: book.id }}>Вернуться к книге</Link></Empty>;
  return <ReaderContent content={query.data} bookId={book.id} title={book.title} author={book.author} excerpt={book.kind === 'excerpt'} />;
}
function ReaderContent({ content, bookId, title, author, excerpt }: { content: BookContent; bookId: string; title: string; author: string; excerpt: boolean }) {
  const { settings, act, notify } = useApp(); const navigate = useNavigate();
  const [chapter, setChapter] = useState<number | null>(null); const [panel, setPanel] = useState<'contents' | 'settings' | 'bookmarks' | null>(null);
  const [bookmarkActive, setBookmarkActive] = useState(false);
  const current = useRef<Position | null>(null); const requested = useRef<Position | null>(null);
  const ready = useRef(false); const flush = useRef<() => Promise<void>>(async () => {});
  const bookmarks = useLiveQuery(() => db.bookmarks.where('bookId').equals(bookId).filter(b => b.version === content.version).toArray(), [bookId, content.version], []);
  const bookmarkIds = useRef(new Set<string>());
  bookmarkIds.current = new Set(bookmarks.map(b => b.id));
  useEffect(() => { setBookmarkActive(!!current.current && bookmarkIds.current.has(bookmarkId(current.current!))); }, [bookmarks]);
  useEffect(() => {
    let cancelled = false;
    void act(async () => {
      const saved = await loadPosition(bookId, content.version);
      if (cancelled) return;
      if (saved && saved.version === content.version) { requested.current = saved; setChapter(Math.max(0, Math.min(content.chapters.length - 1, saved.chapter))); }
      else { setChapter(0); if (saved) notify('Текст обновился. Прежнее место сохранено в истории; новое издание открыто с первой главы.'); }
      await setSettings({ currentBook: bookId });
    });
    return () => { cancelled = true; };
  }, [bookId]);
  useEffect(() => {
    if (chapter === null) return;
    const screen = document.getElementById('screen')!;
    const first = content.chapters[chapter].paragraphs[0];
    const initial = requested.current ?? (current.current?.chapter === chapter ? current.current : null) ?? { bookId, version: content.version, chapter, paragraph: first.id, offset: 0, updatedAt: new Date().toISOString() };
    requested.current = null; ready.current = false; current.current = initial;
    setBookmarkActive(bookmarkIds.current.has(bookmarkId(initial)));
    let timer: ReturnType<typeof setTimeout>;
    let disposed = false;
    async function save() { if (current.current) await db.positions.put({ ...current.current }); }
    flush.current = save;
    const restore = async () => {
      await document.fonts.ready;
      if (disposed) return;
      requestAnimationFrame(() => {
        if (disposed) return;
        const element = document.getElementById(initial.paragraph);
        screen.scrollTop = element ? element.offsetTop + element.offsetHeight * initial.offset - ((screen.querySelector('.reader-head')?.getBoundingClientRect().height ?? 0) + 12) : 0;
        ready.current = true;
        void act(save);
      });
    };
    void restore();
    function locate() {
      if (!ready.current) return;
      const top = screen.getBoundingClientRect().top + (screen.querySelector('.reader-head')?.getBoundingClientRect().height ?? 0) + 12;
      const paragraphs = Array.from(screen.querySelectorAll<HTMLElement>('[data-paragraph]'));
      const el = paragraphs.find(p => p.getBoundingClientRect().bottom > top) ?? paragraphs.at(-1);
      if (!el) return;
      current.current = { bookId, version: content.version, chapter: chapter!, paragraph: el.id, offset: Math.max(0, Math.min(.999, (top - el.getBoundingClientRect().top) / el.offsetHeight)), updatedAt: new Date().toISOString() };
      setBookmarkActive(bookmarkIds.current.has(bookmarkId(current.current!)));
      clearTimeout(timer); timer = setTimeout(() => void act(save), 200);
    }
    function hide() { if (document.hidden) { locate(); void act(save); } }
    screen.addEventListener('scroll', locate, { passive: true }); document.addEventListener('visibilitychange', hide);
    return () => { disposed = true; clearTimeout(timer); screen.removeEventListener('scroll', locate); document.removeEventListener('visibilitychange', hide); void act(save); };
  }, [chapter, bookId, settings.fontSize, settings.font, settings.lineHeight]);
  // Timed data stays outside the reader's React state: text does not rerender every second.
  useEffect(() => {
    if (chapter === null) return;
    const clock = new ReadingClock(); let day = localDay(); let seconds = 0;
    let id = crypto.randomUUID(); let failed = false;
    const persist = () => {
      const row = { id, day, bookId, seconds };
      return db.sessions.put(row).then(() => {}).catch(() => { if (!failed) notify('Не удалось сохранить время чтения. Проверь хранилище.'); failed = true; });
    };
    const tick = () => {
      const today = localDay();
      if (today !== day) { void persist(); id = crypto.randomUUID(); seconds = 0; day = today; clock.pause(); }
      seconds = Math.round((seconds + clock.tick(performance.now(), !document.hidden && document.hasFocus() && !panel && ready.current)) * 1000) / 1000;
      void persist();
    };
    const pause = () => { tick(); clock.pause(); };
    const interval = setInterval(tick, 1000);
    document.addEventListener('visibilitychange', pause); window.addEventListener('blur', pause);
    return () => { clearInterval(interval); pause(); document.removeEventListener('visibilitychange', pause); window.removeEventListener('blur', pause); };
  }, [bookId, chapter, panel]);
  if (chapter === null) return <Empty>Восстанавливаем место чтения…</Empty>;
  async function changeChapter(value: number, position?: Position) {
    if (!await act(() => flush.current())) return;
    requested.current = position ?? null; setPanel(null); setChapter(value);
    if (value === chapter && position) { current.current = position; const el = document.getElementById(position.paragraph); el?.scrollIntoView({ block: 'start' }); await act(() => db.positions.put(position)); }
  }
  async function leave() { if (await act(() => flush.current())) await navigate({ to: '/book/$bookId', params: { bookId } }); }
  async function bookmark() {
    if (!current.current) return;
    const p = { ...current.current };
    if (await act(() => toggleBookmark(p, content.chapters[chapter!].title), 'Закладки сохранены на устройстве')) setBookmarkActive(!!await db.bookmarks.get(bookmarkId(p)));
  }
  const active = content.chapters[chapter];
  return <><header className="reader-head"><button className="circle" aria-label="Закрыть читалку" onClick={() => void leave()}><Icon name="back" /></button><div className="title"><b>{title}</b>{author}</div><button className="circle" aria-label="Настройки чтения" onClick={() => setPanel('settings')}>Aa</button><button className="circle" aria-label="Поставить или убрать закладку" aria-pressed={bookmarkActive} onClick={() => void bookmark()}><Icon name="bookmark" /></button></header><div className={styles.tools}><button className="text-button" onClick={() => setPanel('contents')}><Icon name="list" />Оглавление</button><button className="text-button" onClick={() => setPanel('bookmarks')}>Закладки · {bookmarks.length}</button></div><article className={`reader-page ${styles.text}`} style={{ '--reader-size': `${settings.fontSize}px`, '--reader-leading': settings.lineHeight } as CSSProperties}><div className="chapter">{excerpt ? 'ОРИГИНАЛЬНЫЙ ФРАГМЕНТ' : 'ТЕСТОВЫЙ ПОЛНЫЙ ТЕКСТ'} · {chapter + 1} / {content.chapters.length}</div><h1>{active.title}</h1><div className={`reader-text ${settings.font === 'sans' ? 'sans' : ''}`}>{active.paragraphs.map(p => <p id={p.id} data-paragraph key={p.id}>{p.text}</p>)}</div></article><footer className="reader-footer"><div className="page-controls"><button className="circle" disabled={chapter === 0} aria-label="Предыдущая глава" onClick={() => void changeChapter(chapter - 1)}><Icon name="back" /></button><small>Глава {chapter + 1} из {content.chapters.length}</small><button className="circle" disabled={chapter === content.chapters.length - 1} aria-label="Следующая глава" onClick={() => void changeChapter(chapter + 1)}><Icon name="arrow" /></button></div>{chapter === content.chapters.length - 1 && <p className="reader-note">Конец {excerpt ? 'фрагмента' : 'текста'}. Переход сюда не отмечает книгу прочитанной.</p>}<button className="primary section" onClick={() => void leave()}>Сохранить и выйти<Icon name="check" /></button><p className="reader-note section">Сохранено на устройстве · синхронизация ещё не подключена</p></footer>{panel && <Modal title={panel === 'contents' ? 'Оглавление' : panel === 'bookmarks' ? 'Твои закладки' : 'Твоё пространство'} close={() => setPanel(null)}>{panel === 'contents' ? content.chapters.map((c, i) => <button key={c.id} className="goal-option" aria-current={i === chapter ? 'location' : undefined} onClick={() => void changeChapter(i)}>{String(i + 1).padStart(2, '0')} — {c.title}</button>) : panel === 'bookmarks' ? bookmarks.length ? bookmarks.map(b => <div className="bookmark-row" key={b.id}><button className="text-button" onClick={() => void changeChapter(b.chapter, b)}>{b.label}</button><button className="circle" aria-label={`Удалить закладку: ${b.label}`} onClick={() => void act(() => db.bookmarks.delete(b.id))}><Icon name="close" /></button></div>) : <Empty>Сохрани первый момент кнопкой закладки.</Empty> : <><label htmlFor="font-size">Размер текста · {settings.fontSize}</label><input id="font-size" type="range" min="15" max="32" value={settings.fontSize} onChange={e => void act(() => setSettings({ fontSize: Number(e.target.value) }))} /><label>Начертание</label><div className="choice-row">{(['serif', 'sans'] as const).map((font, i) => <button className={`pill ${settings.font === font ? 'active' : ''}`} key={font} aria-pressed={settings.font === font} onClick={() => void act(() => setSettings({ font }))}>{['Книжное', 'Современное'][i]}</button>)}</div><label htmlFor="line-height">Межстрочный интервал</label><select id="line-height" value={settings.lineHeight} onChange={e => void act(() => setSettings({ lineHeight: Number(e.target.value) }))}>{[1.5, 1.75, 1.95, 2.2].map(n => <option key={n} value={n}>{n}</option>)}</select></>}</Modal>}</>;
}
