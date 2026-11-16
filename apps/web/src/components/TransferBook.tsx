import type { ReactNode } from 'react';
import catalog from '../data/catalog.json';
import { Cover, Icon } from './ui';

export function TransferBook({ bookId, children }: { bookId: string; children?: ReactNode }) {
 const book = catalog.find(item => item.id === bookId);
 return <div className="transfer-book">
  {book ? <Cover id={book.cover} title={book.title} /> : <Icon name="book" />}
  <div><strong>{book?.title ?? bookId}</strong>{book && <small>{book.author}</small>}{children}</div>
 </div>;
}
