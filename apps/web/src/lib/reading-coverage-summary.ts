import type { BookContent } from './books';
import { mergeTextRanges, type ParagraphCoverage, type TextRange } from './reading-coverage';

// Count paragraphs, never infer a reading percentage from paragraph geometry.
export function summarizeReadingCoverage(content: BookContent, rows: ParagraphCoverage[]) {
 const edition = new Map<string, TextRange[]>();
 for (const row of rows) {
  if (row.bookId !== content.id || row.version !== content.version) continue;
  const key = JSON.stringify([row.chapter, row.paragraph]);
  edition.set(key, [...(edition.get(key) ?? []), ...row.ranges]);
 }
 return content.chapters.map(chapter => {
  let full = 0; let partial = 0;
  for (const paragraph of chapter.paragraphs) {
   const ranges = mergeTextRanges(edition.get(JSON.stringify([chapter.id, paragraph.id])) ?? []);
   if (ranges.length === 1 && ranges[0][0] === 0 && ranges[0][1] === 1) full++;
   else if (ranges.length) partial++;
  }
  return { full, partial, unseen: chapter.paragraphs.length - full - partial, total: chapter.paragraphs.length };
 });
}
