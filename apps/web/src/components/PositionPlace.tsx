import { useQuery } from '@tanstack/react-query';
import { loadBook, type Book } from '../lib/books';
import type { ReadingLocator } from '../lib/positions';
import catalog from '../data/catalog.json';
export function Place({ title, position, bookId }: { title: string; position?: ReadingLocator; bookId: string }) {
 const book = catalog.find(book => book.id === bookId) as Book | undefined;
 const content = useQuery({ queryKey: ['book', book?.id], queryFn: () => loadBook(book!), enabled: !!book && !!position, retry: false, staleTime: Infinity });
 const chapter = content.data && content.data.version === position?.version && position ? content.data.chapters[position.chapter] : undefined;
 const paragraph = chapter?.paragraphs.findIndex(p => p.id === position?.paragraph) ?? -1;
 return <div className="section"><h3>{title}</h3><p className="description">{!position ? 'Место ещё не сохранено.' : `Глава ${position.chapter + 1}${paragraph >= 0 ? ` · абзац ${paragraph + 1} · ${Math.round(position.offset * 100)}% абзаца` : ''}${position.version !== book?.version ? ' · прежнее издание' : ''}`}</p>{paragraph >= 0 && <p className="description">«{chapter!.paragraphs[paragraph].text.slice(0, 140)}…»</p>}{content.isError && <p className="description">Текст для сравнения недоступен. Главы указаны по сохранённым местам.</p>}</div>;
}
