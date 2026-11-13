import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import type { BookContent } from '../lib/books';
import type { LocalDatabase } from '../lib/db';
import { summarizeReadingCoverage } from '../lib/reading-coverage-summary';
import styles from '../pages/Reader.module.css';

export function ReaderContents({ content, store, chapter, changeChapter, openParagraph }: {
 content: BookContent; store: LocalDatabase; chapter: number; changeChapter: (chapter: number) => void;
 openParagraph: (chapter: number, paragraph: string, offset: number) => void;
}) {
 const [state, setState] = useState<{ summary?: ReturnType<typeof summarizeReadingCoverage>; error?: boolean }>({});
 const [attempt, setAttempt] = useState(0);
 useEffect(() => {
  setState({});
  const subscription = liveQuery(async () => summarizeReadingCoverage(content,
   await store.coverage.where('[bookId+version]').equals([content.id, content.version]).toArray(),
  )).subscribe({ next: summary => setState({ summary }), error: () => setState({ error: true }) });
  return () => subscription.unsubscribe();
 }, [store, content, attempt]);
 return <><p className="reader-note section">Показанные абзацы — сохранённые участки текста, которые появлялись на экране. Это не подтверждение прочтения. Можно вернуться к первому непоказанному участку главы. Место приблизительное и может сместиться при изменении шрифта.</p>
  {state.error ? <p className="description" role="alert">Не удалось загрузить фрагменты. <button className="text-button" onClick={() => setAttempt(value => value + 1)}>Повторить</button></p> : !state.summary && <p className="description" role="status">Загружаем фрагменты…</p>}
  {content.chapters.map((item, index) => {
   const counts = state.summary?.[index];
   return <div key={item.id} className={`goal-option ${styles.contentsItem}`}>
    <button className={styles.contentsChapter} aria-current={index === chapter ? 'location' : undefined} onClick={() => changeChapter(index)}>
    <span>{String(index + 1).padStart(2, '0')} — {item.title}</span>
    {counts && <small>Абзацы · целиком: {counts.full} · частично: {counts.partial} · ещё не показаны: {counts.unseen}</small>}
    </button>
    {counts && counts.firstIncomplete !== null && <button className="text-button" aria-label={`${item.title}: открыть первый непоказанный участок, абзац ${counts.firstIncomplete + 1}`} onClick={() => openParagraph(index, item.paragraphs[counts.firstIncomplete!].id, counts.firstIncompleteOffset!)}>К непоказанному участку · абзац {counts.firstIncomplete + 1} →</button>}
   </div>;
  })}
 </>;
}
