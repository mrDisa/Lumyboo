import { Link } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { db } from '../lib/db';
import { reconcileDownloads, removeDownload, type Book } from '../lib/books';
import { useApp } from '../lib/context';
import { Cover, Empty, Icon } from '../components/ui';
import { books } from './Library';
export function Downloads() {
  const downloads = useLiveQuery(() => db.downloads.toArray(), [], []);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const { act } = useApp();
  useEffect(() => { let active = true; void act(async () => { await reconcileDownloads(books); }).finally(() => { if (active) setChecking(false); }); return () => { active = false; }; }, []);
  const available = books.filter(book => downloads.some(d => d.bookId === book.id));
  async function remove(book: Book) {
    setBusy(book.id);
    await act(() => removeDownload(book), 'Загрузка удалена. Позиция и закладки остались на устройстве.');
    setBusy(null);
  }
  return <><Link className="text-button" to="/catalog">← Каталог</Link><h1 className="section">Истории<br /><em className="serif">под рукой.</em></h1><p className="description">Скачанные тексты для чтения без сети.</p>{checking ? <Empty>Проверяем сохранённые книги…</Empty> : available.length ? <><p className="reader-note downloads-summary">{available.length} {available.length === 1 ? 'книга' : available.length < 5 ? 'книги' : 'книг'} · {Math.ceil(downloads.reduce((n, d) => n + d.bytes, 0) / 1024)} КБ на устройстве</p><div className="download-list">{available.map(book => <article className="download-card" key={book.id}><Link to="/book/$bookId" params={{ bookId: book.id }} className="download-cover"><Cover id={book.cover} title={book.title} /></Link><div className="download-info"><h3>{book.title}</h3><p>{book.author}</p><Link className="text-button download-read" to="/read/$bookId" params={{ bookId: book.id }}>Читать <Icon name="arrow" /></Link></div><button className="circle" aria-label={`Удалить загрузку: ${book.title}`} disabled={busy !== null} onClick={() => void remove(book)}><Icon name="close" /></button></article>)}</div><p className="reader-note section">Удаление загрузки освобождает место и сохраняет закладки. Браузер тоже может освобождать хранилище — наличие текстов проверяется при открытии.</p></> : <Empty><p>Пока нет скачанных историй.</p><p className="section">Открой книгу в каталоге и нажми «Скачать», пока есть сеть.</p><Link className="secondary section" to="/catalog">Выбрать книгу</Link></Empty>}</>;
}
