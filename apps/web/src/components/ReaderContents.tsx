import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import type { BookContent } from '../lib/books';
import type { LocalDatabase } from '../lib/db';
import { chapterUnshownLocations, firstUnshownLocation, summarizeReadingCoverage } from '../lib/reading-coverage-summary';
import type { ParagraphCoverage } from '../lib/reading-coverage';
import styles from '../pages/Reader.module.css';

export function ReaderContents({ content, store, chapter, changeChapter, openParagraph }: {
 content: BookContent; store: LocalDatabase; chapter: number; changeChapter: (chapter: number) => void;
 openParagraph: (chapter: number, paragraph: string, offset: number) => void;
}) {
 const [state, setState] = useState<{ summary?: ReturnType<typeof summarizeReadingCoverage>; rows?: ParagraphCoverage[]; error?: boolean }>({});
 const [attempt, setAttempt] = useState(0);
 useEffect(() => {
  setState({});
  const subscription = liveQuery(async () => {
   const rows = await store.coverage.where('[bookId+version]').equals([content.id, content.version]).toArray();
   return { rows, summary: summarizeReadingCoverage(content, rows) };
  }).subscribe({ next: value => setState(value), error: () => setState({ error: true }) });
  return () => subscription.unsubscribe();
 }, [store, content, attempt]);
 const firstUnshown = state.summary ? firstUnshownLocation(state.summary) : null;
 return <div className={styles.contents}><div className={styles.contentsIntro}><span>Главы книги</span><b>{content.chapters.length}</b></div><details className={styles.coverageHelp}><summary>Что означают отметки?</summary><p className="reader-note">Показанные абзацы — сохранённые участки текста, которые появлялись на экране. Это не подтверждение прочтения. Можно вернуться к первому непоказанному участку главы. Место приблизительное и может сместиться при изменении шрифта.</p></details>
  {state.error ? <p className="description" role="alert">Не удалось загрузить фрагменты. <button className="text-button" onClick={() => setAttempt(value => value + 1)}>Повторить</button></p> : !state.summary && <p className="description" role="status">Загружаем фрагменты…</p>}
  {firstUnshown && <button className="secondary section" onClick={() => openParagraph(firstUnshown.chapter, content.chapters[firstUnshown.chapter].paragraphs[firstUnshown.paragraph].id, firstUnshown.offset)}>Продолжить с непоказанного →</button>}
  {content.chapters.map((item, index) => {
   const counts = state.summary?.[index];
   return <div key={item.id} className={styles.contentsItem} data-current={index === chapter || undefined}>
    <button className={styles.contentsChapter} aria-current={index === chapter ? 'location' : undefined} onClick={() => changeChapter(index)}>
    <span className={styles.chapterHeading}><span className={styles.chapterNumber}>{String(index + 1).padStart(2, '0')}</span><span className={styles.chapterTitle}>{index === chapter && <small className={styles.currentChapter}>Сейчас читаешь</small>}{item.title}</span><span aria-hidden="true">→</span></span>
    {counts && <><small className={styles.coverageLabel}>Показанные абзацы</small><span className={styles.coverageBar} aria-hidden="true"><span style={{ flex: counts.full }} /><span style={{ flex: counts.partial }} /><span style={{ flex: counts.unseen }} /></span><span className={styles.coverageStats}><span><b>{counts.full}</b>целиком</span><span><b>{counts.partial}</b>частично</span><span><b>{counts.unseen}</b>не показаны</span></span></>}
    </button>
    {counts && counts.firstIncomplete !== null && <button className="text-button" aria-label={`${item.title}: открыть первый непоказанный участок, абзац ${counts.firstIncomplete + 1}`} onClick={() => openParagraph(index, item.paragraphs[counts.firstIncomplete!].id, counts.firstIncompleteOffset!)}>Дальше · абзац {counts.firstIncomplete + 1} →</button>}
    {counts && counts.firstIncomplete !== null && state.rows && <ChapterGaps key={JSON.stringify([store.name, content.id, content.version, item.id])} content={content} rows={state.rows} chapter={index} openParagraph={openParagraph} />}
   </div>;
  })}
 </div>;
}

function ChapterGaps({ content, rows, chapter, openParagraph }: {
 content: BookContent; rows: ParagraphCoverage[]; chapter: number;
 openParagraph: (chapter: number, paragraph: string, offset: number) => void;
}) {
 const [expanded, setExpanded] = useState(false);
 const [limit, setLimit] = useState(20);
 const gaps = expanded ? chapterUnshownLocations(content, rows, chapter) : [];
 return <details className={styles.gaps} onToggle={event => { setExpanded(event.currentTarget.open); if (!event.currentTarget.open) setLimit(20); }}>
  <summary>Все непоказанные участки</summary>
  {expanded && <><ol className={styles.gapList}>{gaps.slice(0, limit).map((gap, index) => {
   const paragraph = content.chapters[chapter].paragraphs[gap.paragraph];
   return <li key={`${paragraph.id}:${gap.offset}`}><button className={styles.contentsChapter} onClick={() => openParagraph(chapter, paragraph.id, gap.offset)}>
    <span>Абзац {gap.paragraph + 1} · участок {index + 1} →</span>
    <small>{paragraph.text.slice(0, 100)}{paragraph.text.length > 100 ? '…' : ''}</small>
   </button></li>;
  })}</ol>{gaps.length > limit && <button className="text-button" onClick={() => setLimit(value => value + 20)}>Показать ещё · осталось {gaps.length - limit}</button>}</>}
 </details>;
}
