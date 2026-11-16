import { Link } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { db } from '../lib/db';
import { reconcileDownloads, removeDownload, type Book } from '../lib/books';
import { useApp } from '../lib/context';
import { Cover, Empty, Icon, Modal } from '../components/ui';
import { books } from './Library';
export function Downloads() {
  const downloads = useLiveQuery(() => db.downloads.toArray(), [], []);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Book | null>(null);
  const { act } = useApp();
  useEffect(() => { let active = true; void act(async () => { await reconcileDownloads(books); }).finally(() => { if (active) setChecking(false); }); return () => { active = false; }; }, []);
  const available = books.filter(book => downloads.some(d => d.bookId === book.id));
  async function remove(book: Book) {
    setBusy(book.id);
    if (await act(() => removeDownload(book), 'Загрузка удалена. Позиция и закладки остались на устройстве.')) setRemoving(null);
    setBusy(null);
  }
  const totalBytes = downloads.filter(d => available.some(book => book.id === d.bookId)).reduce((n, d) => n + d.bytes, 0);
  return <><Link className="text-button" to="/catalog">← Каталог</Link><h1 className="section">Истории<br /><em className="serif">под рукой.</em></h1>
    {checking ? <Empty>Проверяем сохранённые книги…</Empty> : available.length ? <>
      <div className="download-overview section"><div><strong>{available.length}</strong><span>на устройстве</span></div><div><strong>{Math.ceil(totalBytes / 1024)}<small> КБ</small></strong><span>скачанные тексты</span></div></div>
      <div className="download-list">{available.map(book => <article className="download-card" key={book.id}><Link to="/book/$bookId" params={{ bookId: book.id }} className="download-cover"><Cover id={book.cover} title={book.title} /></Link><div className="download-info"><h3>{book.title}</h3><p>{book.author}</p><p>{Math.ceil((downloads.find(d => d.bookId === book.id)?.bytes ?? 0) / 1024)} КБ · скачано</p><Link className="secondary download-read" to="/read/$bookId" params={{ bookId: book.id }}>Читать <Icon name="arrow" /></Link></div><button className="circle" aria-label={`Удалить загрузку: ${book.title}`} disabled={busy !== null} onClick={() => setRemoving(book)}><Icon name="close" /></button></article>)}</div>
      <details className="goal-details section"><summary>О скачанных книгах</summary><p className="description">Удаление загрузки освобождает место. Позиции и закладки остаются на устройстве. Браузер тоже может освобождать хранилище — наличие текстов проверяется при открытии.</p></details>
    </> : <Empty><Icon name="books" /><h2 className="section">Место для историй</h2><p className="section">Выбери книгу и нажми «Скачать», пока есть сеть.</p><Link className="primary section" to="/catalog">Выбрать книгу<Icon name="arrow" /></Link></Empty>}
    {removing && <Modal title="Удалить загрузку?" close={() => { if (!busy) setRemoving(null); }}><h3>{removing.title}</h3><p className="description section">Текст придётся скачать заново. Позиция и закладки останутся на устройстве.</p><button className="primary section" disabled={busy !== null} onClick={() => void remove(removing)}>{busy ? 'Удаляем…' : 'Удалить загрузку'}</button><button className="secondary section" disabled={busy !== null} onClick={() => setRemoving(null)}>Оставить книгу</button></Modal>}
  </>;
}
