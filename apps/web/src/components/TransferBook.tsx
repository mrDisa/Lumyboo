import type { ReactNode } from 'react';
import catalog from '../data/catalog.json';
import { Cover, Icon } from './ui';

export function TransferBook({ bookId, children, fallback }: { bookId: string; children?: ReactNode; fallback?: string }) {
 const book = catalog.find(item => item.id === bookId);
 return <div className="transfer-book">
  {book ? <Cover id={book.cover} title={book.title} /> : <Icon name="book" />}
  <div><strong>{book?.title ?? fallback ?? bookId}</strong>{book && <small>{book.author}</small>}{children}</div>
 </div>;
}
