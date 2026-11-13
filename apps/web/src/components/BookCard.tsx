import { Link } from '@tanstack/react-router';
import type { Book } from '../lib/books';
import { Cover } from './ui';
export function BookCard({ book }: { book: Book }) { return <Link to="/book/$bookId" params={{ bookId: book.id }} className="book-card"><Cover id={book.cover} title={book.title} /><h3>{book.title}</h3><p>{book.author}</p><p>{book.kind === 'fixture' ? 'Тестовая книга · полный текст' : 'Оригинальный фрагмент'}</p></Link>; }
