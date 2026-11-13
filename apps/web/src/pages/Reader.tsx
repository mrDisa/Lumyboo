import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useAccount, getSession, type AccountSession } from '../lib/auth';
import { loadAccountPositions, samePosition, type ReadingLocator } from '../lib/positions';
import { loadAccountBookmarks } from '../lib/bookmarks';
import { accountDatabase, prepareAccountBook, resumeLocalAccountBook, validReadingLocator } from '../lib/account-reading';
import { Link, useParams, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useLiveQuery } from 'dexie-react-hooks';
import { books } from './Library';
import { loadBook, type BookContent } from '../lib/books';
import { db, setSettings, toggleBookmark, bookmarkId, loadPosition, savePosition, saveReadingSession, deleteBookmark, type Position, type LocalDatabase } from '../lib/db';
import { protectReading } from '../lib/update-guard';
import { ownReading } from '../lib/reading-ownership';
import { ReadingClock, localDay } from '../lib/reading';
import { useApp } from '../lib/context';
import { Empty, Icon, Modal } from '../components/ui';
import styles from './Reader.module.css';
export function AccountReader() { return <Reader accountMode />; }
export function Reader({ accountMode = false }: { accountMode?: boolean }) {
  const { bookId } = useParams({ strict: false }); const book = books.find(b => b.id === bookId);
  const query = useQuery({ queryKey: ['book', bookId], queryFn: () => loadBook(book!), enabled: !!book, retry: false, staleTime: Infinity });
  if (!book) return <Empty>Книга не найдена. <Link to="/catalog">В каталог</Link></Empty>;
  if (query.isPending) return <Empty>Открываем историю…</Empty>;
  if (query.isError) return <Empty><p>{query.error.message}</p><button className="secondary section" onClick={() => void query.refetch()}>Попробовать снова</button><Link to="/book/$bookId" params={{ bookId: book.id }}>Вернуться к книге</Link></Empty>;
  if (accountMode) return <AccountReaderGate content={query.data} bookId={book.id} title={book.title} author={book.author} excerpt={book.kind === 'excerpt'} />;
  return <ReadingOwnership key={book.id} source={db} bookId={book.id}>{registerSave => <ReaderContent content={query.data} bookId={book.id} title={book.title} author={book.author} excerpt={book.kind === 'excerpt'} registerSave={registerSave} />}</ReadingOwnership>;
}
type ReaderProps = { content: BookContent; bookId: string; title: string; author: string; excerpt: boolean };
type RegisterSave = (save: () => Promise<void>) => void;
function ReadingOwnership({ source, bookId, children }: { source: LocalDatabase; bookId: string; children: (registerSave: RegisterSave) => ReactNode }) {
 const { notify } = useApp();
 const [state, setState] = useState<'opening' | 'ready' | 'busy' | 'error'>('opening');
 const [error, setError] = useState(''); const [attempt, setAttempt] = useState(0);
 const save = useRef<() => Promise<void>>(async () => {});
 const registerSave = useCallback<RegisterSave>(callback => { save.current = callback; }, []);
 useEffect(() => ownReading(source.scope, bookId, () => save.current(), () => setState('ready'), () => setState('busy'), error => {
  const message = error instanceof Error ? error.message : 'Не удалось защитить место чтения.';
  setError(message); setState('error'); notify(message);
 }), [source, bookId, attempt]);
 if (state === 'ready') return children(registerSave);
 return <Empty><p role="status">{state === 'busy' ? 'Эта книга уже открыта в другой вкладке.' : state === 'error' ? error : 'Подготавливаем чтение…'}</p>{state === 'busy' && <p className="description">Сохрани и закрой читалку в той вкладке, затем повтори открытие здесь.</p>}{state !== 'opening' && <button className="primary section" onClick={() => { setState('opening'); setAttempt(value => value + 1); }}>Попробовать снова</button>}<Link className="secondary section" to={source.scope === 'guest' ? '/catalog' : '/profile'}>Вернуться {source.scope === 'guest' ? 'в каталог' : 'в профиль'}</Link></Empty>;
}
function AccountReaderGate(props: ReaderProps) {
 const account = useAccount();
 if (account.checking) return <Empty>Проверяем вход…</Empty>;
 if (!account.session) return <Empty><p>{account.error ? 'Не удалось проверить вход. Для открытия данных аккаунта подключись к сети.' : 'Войди, чтобы открыть своё место аккаунта.'}</p><Link className="secondary section" to="/login">Войти</Link><Link className="secondary section" to="/read/$bookId" params={{ bookId: props.bookId }}>Читать как гость</Link></Empty>;
 const session = account.session;
 return <ReadingOwnership key={`${session.user.id}:${props.bookId}`} source={accountDatabase(session.user.id)} bookId={props.bookId}>{registerSave => <AccountReaderStart {...props} session={session} registerSave={registerSave} />}</ReadingOwnership>;
}
function AccountReaderStart(props: ReaderProps & { session: AccountSession; registerSave: RegisterSave }) {
 const store = accountDatabase(props.session.user.id);
 const preparation = useRef<Promise<void>>(Promise.resolve());
 useEffect(() => { props.registerSave(() => preparation.current); }, [props.registerSave]);
 const [attempt, setAttempt] = useState(0);
 const [ready, setReady] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const starting = useRef(false);
 const query = useQuery({ queryKey: ['account-reader-start', props.session.user.id, props.bookId, attempt], gcTime: 0, retry: false, networkMode: 'always', queryFn: async ({ signal }) => {
  const [positions, bookmarks, local, savedChoice] = await Promise.all([loadAccountPositions(props.session.user.id, signal), loadAccountBookmarks(props.session.user.id, signal), store.positions.get(props.bookId), store.positionChoices.get(props.bookId)]);
  return { remote: positions.positions.find(p => p.bookId === props.bookId), bookmarks: bookmarks.bookmarks, local, savedChoice };
 } });
 const data = query.data;
 const remoteValid = !!data?.remote && validReadingLocator(data.remote, props.content);
 const localValid = !!data?.local && validReadingLocator(data.local, props.content);
 const describe = (position: ReadingLocator | undefined) => {
  if (!position) return 'нет сохранённого места';
  if (!validReadingLocator(position, props.content)) return 'место прежнего издания';
  const index = props.content.chapters[position.chapter].paragraphs.findIndex(p => p.id === position.paragraph);
  return `глава ${position.chapter + 1}, абзац ${index + 1}, ${Math.round(position.offset * 100)}% абзаца`;
 };
 const requiresChoice = !!data && (!!data.savedChoice || !!data.local && remoteValid && !samePosition(data.local, data.remote) || !!data.remote && !remoteValid);
 function start(useRemote: boolean) {
  if (!data || busy) return;
  setBusy(true); setError('');
  preparation.current = (async () => {
  try {
   const current = await getSession();
   if (current?.user.id !== props.session.user.id) throw new Error('Аккаунт изменился. Открой книгу из профиля заново.');
   await prepareAccountBook(store, props.content, data.remote, data.bookmarks, useRemote, data.local);
   setReady(true);
  } catch (error) { setError(error instanceof Error ? error.message : 'Не удалось подготовить чтение. Открой книгу заново.'); }
  finally { setBusy(false); }
  })();
  return preparation.current;
 }
 async function startLocal() {
  if (busy) return;
  setBusy(true); setError('');
  try { await resumeLocalAccountBook(store, props.content); setReady(true); }
  catch (error) { setError(error instanceof Error ? error.message : 'Не удалось открыть место на устройстве.'); }
  finally { setBusy(false); }
 }
 useEffect(() => { if (data && !requiresChoice && !starting.current) { starting.current = true; void start(!data.local && remoteValid); } }, [data, requiresChoice]);
 if (ready) return <ReaderContent {...props} source={store} />;
 if (query.isError) return <Empty><p>{query.error.message}</p><p className="description">Если ты уже читал это издание в аккаунте на этом устройстве, можно продолжить с сохранённого места и местными закладками. Для проверки входа нужна сеть.</p><button className="primary section" disabled={busy || query.isFetching} aria-busy={busy} onClick={() => void startLocal()}>Продолжить с места на устройстве</button><p className="description" role="alert">{error}</p><button className="secondary section" disabled={busy || query.isFetching} onClick={() => { setError(''); void query.refetch(); }}>Попробовать снова</button><Link className="secondary section" to="/profile">В профиль</Link></Empty>;
 if (!data) return <Empty>Загружаем место и закладки аккаунта…</Empty>;
 return <><h1>Продолжим историю.</h1><p className="description account-email">{props.session.user.email}</p>{requiresChoice && <><p className="description">На устройстве: {describe(data.local)}. В аккаунте: {describe(data.remote)}.</p><p className="description">Выбери, откуда продолжить. Другой вариант останется в истории или аккаунте. Гостевые данные сохранятся отдельно.</p>{data.savedChoice && <p className="description" role="status">{data.savedChoice.conflict ? 'Есть конфликт сохранённого места. Сравни места заново в профиле.' : 'Для этой книги есть незавершённое сохранение. Проверь его в профиле, прежде чем выбирать место аккаунта.'} Можно продолжить чтение на этом устройстве — сохранённый выбор останется доступен в профиле.</p>}{remoteValid && !data.savedChoice && <button className="primary section" disabled={busy} onClick={() => void start(true)}>Продолжить с места аккаунта</button>}<button className="secondary section" disabled={busy} onClick={() => void start(false)}>{localValid ? 'Продолжить с места на этом устройстве' : 'Начать текущее издание с начала'}</button></>}<p className="description" role="alert">{error || (busy ? 'Подготавливаем чтение…' : '')}</p>{error && <button className="secondary section" disabled={busy || query.isFetching} onClick={() => { starting.current = false; setError(''); setAttempt(value => value + 1); }}>Обновить места и попробовать снова</button>}<Link className="secondary section" to="/profile">В профиль</Link></>;
}
function ReaderContent({ content, bookId, title, author, excerpt, source = db, registerSave }: ReaderProps & { source?: LocalDatabase; registerSave: RegisterSave }) {
  const { settings, act, notify } = useApp(); const navigate = useNavigate();
  const [chapter, setChapter] = useState<number | null>(null); const [panel, setPanel] = useState<'contents' | 'settings' | 'bookmarks' | null>(null);
  const [navigation, setNavigation] = useState(0);
  const [bookmarkActive, setBookmarkActive] = useState(false);
  const [protectedReading, setProtectedReading] = useState(false);
  const [protectionError, setProtectionError] = useState(false);
  const sessionFlush = useRef<() => Promise<void>>(async () => {});
  const current = useRef<Position | null>(null); const requested = useRef<Position | null>(null);
  const ready = useRef(false); const flush = useRef<() => Promise<void>>(async () => {});
  const bookmarks = useLiveQuery(() => source.bookmarks.where('bookId').equals(bookId).filter(b => b.version === content.version).toArray(), [bookId, content.version, source], []);
  const bookmarkIds = useRef(new Set<string>());
  bookmarkIds.current = new Set(bookmarks.map(b => b.id));
  useEffect(() => { setBookmarkActive(!!current.current && bookmarkIds.current.has(bookmarkId(current.current!))); }, [bookmarks]);
  useEffect(() => {
    if (!protectedReading) return;
    let cancelled = false;
    void act(async () => {
      const saved = await loadPosition(bookId, content.version, source);
      if (cancelled) return;
      if (saved && saved.version === content.version) { requested.current = saved; setChapter(Math.max(0, Math.min(content.chapters.length - 1, saved.chapter))); }
      else { setChapter(0); if (saved) notify('Текст обновился. Прежнее место сохранено в истории; новое издание открыто с первой главы.'); }
      if (source.scope === 'guest') await setSettings({ currentBook: bookId });
    });
    return () => { cancelled = true; };
  }, [bookId, protectedReading]);
  useEffect(() => {
    if (chapter === null || !protectedReading) return;
    const screen = document.getElementById('screen')!;
    const first = content.chapters[chapter].paragraphs[0];
    const initial = requested.current ?? (current.current?.chapter === chapter ? current.current : null) ?? { bookId, version: content.version, chapter, paragraph: first.id, offset: 0, updatedAt: new Date().toISOString() };
    requested.current = null; ready.current = false; current.current = initial;
    setBookmarkActive(bookmarkIds.current.has(bookmarkId(initial)));
    let timer: ReturnType<typeof setTimeout>;
    let disposed = false;
    async function save() { if (current.current) await savePosition({ ...current.current }, source); }
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
  }, [chapter, navigation, bookId, protectedReading, settings.fontSize, settings.font, settings.lineHeight]);
  // Timed data stays outside the reader's React state: text does not rerender every second.
  useEffect(() => {
    if (chapter === null || !protectedReading) return;
    const clock = new ReadingClock(); let day = localDay(); let seconds = 0;
    let id = crypto.randomUUID(); let failed = false;
    const persist = () => {
      const row = { id, day, bookId, seconds };
      return saveReadingSession(row, source);
    };
    const report = () => { if (!failed) notify('Не удалось сохранить время чтения. Проверь хранилище.'); failed = true; };
    const tick = () => {
      let previousDay: Promise<void> = Promise.resolve();
      const today = localDay();
      if (today !== day) { previousDay = persist(); id = crypto.randomUUID(); seconds = 0; day = today; clock.pause(); }
      seconds = Math.round((seconds + clock.tick(performance.now(), !document.hidden && document.hasFocus() && !panel && ready.current)) * 1000) / 1000;
      return Promise.all([previousDay, persist()]).then(() => {});
    };
    const pause = () => { const saved = tick(); clock.pause(); return saved; };
    sessionFlush.current = pause;
    const pauseAndReport = () => { void pause().catch(report); };
    const interval = setInterval(() => { void tick().catch(report); }, 1000);
    document.addEventListener('visibilitychange', pauseAndReport); window.addEventListener('blur', pauseAndReport);
    return () => { clearInterval(interval); pauseAndReport(); document.removeEventListener('visibilitychange', pauseAndReport); window.removeEventListener('blur', pauseAndReport); };
  }, [bookId, chapter, panel, protectedReading]);
  async function flushReading() { await Promise.all([flush.current(), sessionFlush.current()]); }
  useEffect(() => { registerSave(flushReading); }, [registerSave]);
  useEffect(() => protectReading(flushReading, () => setProtectedReading(true), () => {
    setProtectionError(true);
    notify('Не удалось сохранить чтение. Обновление отложено; проверь хранилище.');
  }), [bookId]);
  if (!protectedReading) return <Empty>{protectionError ? 'Не удалось подготовить чтение. Проверь доступ к хранилищу и попробуй снова.' : 'Подготавливаем безопасное чтение…'}<Link className="secondary section" to="/catalog">В каталог</Link></Empty>;
  if (chapter === null) return <Empty>Восстанавливаем место чтения…</Empty>;
  async function changeChapter(value: number, position?: Position) {
    if (!await act(flushReading)) return;
    requested.current = position ?? { bookId, version: content.version, chapter: value, paragraph: content.chapters[value].paragraphs[0].id, offset: 0, updatedAt: new Date().toISOString() };
    // Every deliberate jump uses the same font-aware restoration, including
    // bookmarks and the contents entry for the already displayed chapter.
    setPanel(null); setChapter(value); setNavigation(value => value + 1);
  }
  async function leave() { if (!await act(flushReading)) return; if (source.scope === 'guest') await navigate({ to: '/book/$bookId', params: { bookId } }); else await navigate({ to: '/profile' }); }
  async function bookmark() {
    if (!current.current) return;
    const p = { ...current.current };
    if (await act(() => toggleBookmark(p, content.chapters[chapter!].title, source), 'Закладки сохранены на устройстве')) setBookmarkActive(!!await source.bookmarks.get(bookmarkId(p)));
  }
  const active = content.chapters[chapter];
  return <><header className="reader-head"><button className="circle" aria-label="Закрыть читалку" onClick={() => void leave()}><Icon name="back" /></button><div className="title"><b>{title}</b>{author}</div><button className="circle" aria-label="Настройки чтения" onClick={() => setPanel('settings')}>Aa</button><button className="circle" aria-label="Поставить или убрать закладку" aria-pressed={bookmarkActive} onClick={() => void bookmark()}><Icon name="bookmark" /></button></header><div className={styles.tools}><button className="text-button" onClick={() => setPanel('contents')}><Icon name="list" />Оглавление</button><button className="text-button" onClick={() => setPanel('bookmarks')}>Закладки · {bookmarks.length}</button></div><article className={`reader-page ${styles.text}`} style={{ '--reader-size': `${settings.fontSize}px`, '--reader-leading': settings.lineHeight } as CSSProperties}><div className="chapter">{excerpt ? 'ОРИГИНАЛЬНЫЙ ФРАГМЕНТ' : 'ТЕСТОВЫЙ ПОЛНЫЙ ТЕКСТ'} · {chapter + 1} / {content.chapters.length}</div><h1>{active.title}</h1><div className={`reader-text ${settings.font === 'sans' ? 'sans' : ''}`}>{active.paragraphs.map(p => <p id={p.id} data-paragraph key={p.id}>{p.text}</p>)}</div></article><footer className="reader-footer"><div className="page-controls"><button className="circle" disabled={chapter === 0} aria-label="Предыдущая глава" onClick={() => void changeChapter(chapter - 1)}><Icon name="back" /></button><small>Глава {chapter + 1} из {content.chapters.length}</small><button className="circle" disabled={chapter === content.chapters.length - 1} aria-label="Следующая глава" onClick={() => void changeChapter(chapter + 1)}><Icon name="arrow" /></button></div>{chapter === content.chapters.length - 1 && <p className="reader-note">Конец {excerpt ? 'фрагмента' : 'текста'}. Переход сюда не отмечает книгу прочитанной.</p>}<button className="primary section" onClick={() => void leave()}>Сохранить и выйти<Icon name="check" /></button><p className="reader-note section">{source.scope === 'guest' ? 'Гостевое место сохранено на устройстве' : 'Место этого аккаунта сохранено на устройстве. Отправить его на сервер можно в профиле.'}</p></footer>{panel && <Modal title={panel === 'contents' ? 'Оглавление' : panel === 'bookmarks' ? 'Твои закладки' : 'Твоё пространство'} close={() => setPanel(null)}>{panel === 'contents' ? content.chapters.map((c, i) => <button key={c.id} className="goal-option" aria-current={i === chapter ? 'location' : undefined} onClick={() => void changeChapter(i)}>{String(i + 1).padStart(2, '0')} — {c.title}</button>) : panel === 'bookmarks' ? bookmarks.length ? bookmarks.map(b => <div className="bookmark-row" key={b.id}><button className="text-button" onClick={() => void changeChapter(b.chapter, b)}>{b.label}</button><button className="circle" aria-label={`Удалить закладку: ${b.label}`} onClick={() => void act(() => deleteBookmark(b.id, source))}><Icon name="close" /></button></div>) : <Empty>Сохрани первый момент кнопкой закладки.</Empty> : <><label htmlFor="font-size">Размер текста · {settings.fontSize}</label><input id="font-size" type="range" min="15" max="32" value={settings.fontSize} onChange={e => void act(() => setSettings({ fontSize: Number(e.target.value) }))} /><label>Начертание</label><div className="choice-row">{(['serif', 'sans'] as const).map((font, i) => <button className={`pill ${settings.font === font ? 'active' : ''}`} key={font} aria-pressed={settings.font === font} onClick={() => void act(() => setSettings({ font }))}>{['Книжное', 'Современное'][i]}</button>)}</div><label htmlFor="line-height">Межстрочный интервал</label><select id="line-height" value={settings.lineHeight} onChange={e => void act(() => setSettings({ lineHeight: Number(e.target.value) }))}>{[1.5, 1.75, 1.95, 2.2].map(n => <option key={n} value={n}>{n}</option>)}</select></>}</Modal>}</>;
}
