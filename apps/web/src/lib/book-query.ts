import { queryOptions } from '@tanstack/react-query';
import { loadBook, type Book } from './books';

export function bookQueryOptions(book: Book | undefined) {
 return queryOptions({
  queryKey: ['book', book?.id],
  queryFn: () => loadBook(book!),
  enabled: !!book,
  // loadBook checks verified Cache Storage before attempting a network fetch.
  // An offline cold start must still run that local check.
  networkMode: 'always',
  retry: false,
  staleTime: Infinity,
 });
}
