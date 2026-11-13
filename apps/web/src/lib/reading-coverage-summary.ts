import type { BookContent } from './books';
import { mergeTextRanges, type ParagraphCoverage, type TextRange } from './reading-coverage';

function editionRanges(content: BookContent, rows: ParagraphCoverage[]) {
 const edition = new Map<string, TextRange[]>();
 for (const row of rows) {
  if (row.bookId !== content.id || row.version !== content.version) continue;
  const key = JSON.stringify([row.chapter, row.paragraph]);
  edition.set(key, [...(edition.get(key) ?? []), ...row.ranges]);
 }
 return edition;
}

// Complement the saved geometry, preserving every gap without rounding it.
export function chapterUnshownLocations(content: BookContent, rows: ParagraphCoverage[], chapter: number) {
 const edition = editionRanges(content, rows);
 return (content.chapters[chapter]?.paragraphs ?? []).flatMap((paragraph, index) => {
  const ranges = mergeTextRanges(edition.get(JSON.stringify([content.chapters[chapter].id, paragraph.id])) ?? []);
  const gaps: { paragraph: number; offset: number; end: number }[] = [];
  let end = 0;
  for (const range of ranges) {
   if (range[0] > end) gaps.push({ paragraph: index, offset: end, end: range[0] });
   end = range[1];
  }
  if (end < 1) gaps.push({ paragraph: index, offset: end, end: 1 });
  return gaps;
 });
}

// Follow book order, regardless of the current chapter or the order of stored rows.
export function firstUnshownLocation(summary: ReturnType<typeof summarizeReadingCoverage>) {
 for (const [chapter, counts] of summary.entries()) {
  if (counts.firstIncomplete !== null && counts.firstIncompleteOffset !== null) {
   return { chapter, paragraph: counts.firstIncomplete, offset: counts.firstIncompleteOffset };
  }
 }
 return null;
}

// Count paragraphs, never infer a reading percentage from paragraph geometry.
export function summarizeReadingCoverage(content: BookContent, rows: ParagraphCoverage[]) {
 const edition = editionRanges(content, rows);
 return content.chapters.map(chapter => {
  let full = 0; let partial = 0; let firstIncomplete: number | null = null; let firstIncompleteOffset: number | null = null;
  for (const [index, paragraph] of chapter.paragraphs.entries()) {
   const ranges = mergeTextRanges(edition.get(JSON.stringify([chapter.id, paragraph.id])) ?? []);
   if (ranges.length === 1 && ranges[0][0] === 0 && ranges[0][1] === 1) full++;
   else {
    if (firstIncomplete === null) {
     firstIncomplete = index;
     // Merged ranges are ordered and disjoint. Only a range starting at zero
     // can cover the prefix; its end is the first gap, including tiny gaps.
     firstIncompleteOffset = ranges[0]?.[0] === 0 ? ranges[0][1] : 0;
    }
    if (ranges.length) partial++;
   }
  }
  return { full, partial, unseen: chapter.paragraphs.length - full - partial, total: chapter.paragraphs.length, firstIncomplete, firstIncompleteOffset };
 });
}
