import type { BookContent } from './books';
import { db, type LocalDatabase } from './db';

export type TextRange = [number, number];
export interface ParagraphCoverage {
 bookId: string;
 version: string;
 chapter: string;
 paragraph: string;
 ranges: TextRange[];
}
export interface VisibleParagraph { id: string; top: number; bottom: number }
export interface CoverageSample { paragraph: string; range: TextRange }

// Geometric fractions of a paragraph, not proof of reading or completion.
// Quantization prevents tiny layout noise from producing unbounded fragments.
export function visibleTextRanges(paragraphs: VisibleParagraph[], top: number, bottom: number): CoverageSample[] {
 if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom <= top) return [];
 return paragraphs.flatMap(p => {
  if (!Number.isFinite(p.top) || !Number.isFinite(p.bottom) || p.bottom <= p.top) return [];
  const start = Math.max(top, p.top); const end = Math.min(bottom, p.bottom);
  if (end <= start) return [];
  const from = Math.ceil((start - p.top) / (p.bottom - p.top) * 1_000_000) / 1_000_000;
  const to = Math.floor((end - p.top) / (p.bottom - p.top) * 1_000_000) / 1_000_000;
  return to > from ? [{ paragraph: p.id, range: [from, to] as TextRange }] : [];
 });
}
export function mergeTextRanges(ranges: TextRange[]): TextRange[] {
 const result: TextRange[] = [];
 for (const [from, to] of ranges.map(([from, to]): TextRange => [from, to]).sort((a, b) => a[0] - b[0])) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to > 1 || from >= to) throw new Error('Некорректный фрагмент текста.');
  const previous = result.at(-1);
  if (previous && from <= previous[1]) previous[1] = Math.max(previous[1], to);
  else result.push([from, to]);
 }
 return result;
}

// One recorder per open reader, across chapter/dialog effects. Observations
// remain in memory until the exact snapshot has committed. flush also drains
// observations added during an in-flight write; a failure leaves all for retry.
export function createCoverageRecorder(save: (samples: CoverageSample[]) => Promise<void>) {
 const pending = new Map<string, TextRange[]>();
 let inFlight: Promise<void> | undefined;
 function observe(samples: CoverageSample[]) {
  const next = new Map(pending);
  for (const { paragraph, range } of samples) {
   const ranges = mergeTextRanges([...(next.get(paragraph) ?? []), range]);
   if (JSON.stringify(next.get(paragraph)) !== JSON.stringify(ranges)) next.set(paragraph, ranges);
  }
  // Invalid observations must not partially change the retry buffer.
  for (const [paragraph, ranges] of next) pending.set(paragraph, ranges);
 }
 async function flush(): Promise<void> {
  if (inFlight) { await inFlight; return flush(); }
  if (!pending.size) return;
  const snapshot = new Map(pending);
  const samples = Array.from(snapshot, ([paragraph, ranges]) => ranges.map(([from, to]) => ({ paragraph, range: [from, to] as TextRange }))).flat();
  inFlight = Promise.resolve().then(() => save(samples)).then(() => {
   for (const [paragraph, ranges] of snapshot) if (pending.get(paragraph) === ranges) pending.delete(paragraph);
  }).finally(() => { inFlight = undefined; });
  await inFlight;
  return flush();
 }
 return { observe, flush };
}
// Deliberately local-only until a separate server protocol is implemented.
// Guest/account isolation comes from the database, not a cookie or catalog ID.
export async function saveReadingCoverage(content: BookContent, samples: CoverageSample[], store: LocalDatabase = db) {
 if (!samples.length) return;
 const paragraphs = new Map(content.chapters.flatMap(chapter => chapter.paragraphs.map(p => [p.id, chapter.id] as const)));
 const grouped = new Map<string, TextRange[]>();
 for (const sample of samples) {
  if (!paragraphs.has(sample.paragraph)) throw new Error('Фрагмент отсутствует в этом издании.');
  grouped.set(sample.paragraph, [...(grouped.get(sample.paragraph) ?? []), sample.range]);
 }
 await store.transaction('rw', store.coverage, async () => {
  for (const [paragraph, incoming] of grouped) {
   const key: [string, string, string] = [content.id, content.version, paragraph];
   const previous = await store.coverage.get(key);
   const chapter = paragraphs.get(paragraph)!;
   if (previous && previous.chapter !== chapter) throw new Error('Структура издания изменилась.');
   const ranges = mergeTextRanges([...(previous?.ranges ?? []), ...incoming]);
   if (JSON.stringify(previous?.ranges) === JSON.stringify(ranges)) continue;
   await store.coverage.put({ bookId: content.id, version: content.version, chapter, paragraph, ranges });
  }
 });
}

export function sampleVisibleText(screen: HTMLElement): CoverageSample[] {
 const bounds = screen.getBoundingClientRect();
 const header = screen.querySelector('.reader-head')?.getBoundingClientRect();
 const top = Math.max(bounds.top, 0, header?.bottom ?? bounds.top);
 const bottom = Math.min(bounds.bottom, window.innerHeight);
 return visibleTextRanges(Array.from(screen.querySelectorAll<HTMLElement>('[data-paragraph]'), p => {
  const rect = p.getBoundingClientRect(); return { id: p.id, top: rect.top, bottom: rect.bottom };
 }), top, bottom);
}
