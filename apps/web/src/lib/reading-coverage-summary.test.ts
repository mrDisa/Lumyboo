import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { liveQuery } from 'dexie';
import type { BookContent } from './books';
import { LocalDatabase } from './db';
import { saveReadingCoverage, type ParagraphCoverage } from './reading-coverage';
import { chapterUnshownLocations, firstUnshownLocation, summarizeReadingCoverage } from './reading-coverage-summary';

const content: BookContent = { id: 'book', version: '1', chapters: [
 { id: 'a', title: 'A', paragraphs: [{ id: 'p1', text: 'One' }, { id: 'p2', text: 'Two' }] },
 { id: 'b', title: 'B', paragraphs: [{ id: 'p3', text: 'Three' }] },
] };
const row = (paragraph: string, ranges: ParagraphCoverage['ranges'], patch: Partial<ParagraphCoverage> = {}): ParagraphCoverage => ({ bookId: 'book', version: '1', chapter: 'a', paragraph, ranges, ...patch });

it('lists every missing prefix, internal gap and suffix in paragraph order', () => {
 const rows = [row('p2', [[.2, .3]]), row('p1', [[.1, .4], [.400001, .8]])];
 const before = structuredClone(rows);
 expect(chapterUnshownLocations(content, rows, 0)).toEqual([
  { paragraph: 0, offset: 0, end: .1 }, { paragraph: 0, offset: .4, end: .400001 }, { paragraph: 0, offset: .8, end: 1 },
  { paragraph: 1, offset: 0, end: .2 }, { paragraph: 1, offset: .3, end: 1 },
 ]);
 expect(rows).toEqual(before);
});

it('merges observations, ignores foreign locators and removes filled gaps from the list', () => {
 const rows = [row('p1', [[0, .4]]), row('p1', [[.3, 1]]), row('p2', [[0, 1]], { version: 'old' }),
  row('p2', [[0, 1]], { bookId: 'other' }), row('p2', [[0, 1]], { chapter: 'b' })];
 expect(chapterUnshownLocations(content, rows, 0)).toEqual([{ paragraph: 1, offset: 0, end: 1 }]);
 rows.push(row('p2', [[0, 1]]));
 expect(chapterUnshownLocations(content, rows, 0)).toEqual([]);
 expect(chapterUnshownLocations(content, rows, 1)).toEqual([{ paragraph: 0, offset: 0, end: 1 }]);
 expect(chapterUnshownLocations(content, rows, 5)).toEqual([]);
 expect(chapterUnshownLocations({ ...content, chapters: [{ id: 'empty', title: 'Empty', paragraphs: [] }] }, rows, 0)).toEqual([]);
});

it('returns to skipped text in book order, then advances after coverage fills the gap', () => {
 const rows = [row('p3', [[0, 1]], { chapter: 'b' }), row('p2', [[0, 1]]), row('p1', [[0, .4], [.400001, 1]])];
 const target = () => firstUnshownLocation(summarizeReadingCoverage(content, rows));
 expect(target()).toEqual({ chapter: 0, paragraph: 0, offset: .4 });
 rows.push(row('p1', [[.4, .400001]]));
 expect(target()).toBeNull();
 rows.shift();
 expect(target()).toEqual({ chapter: 1, paragraph: 0, offset: 0 });
});

it('skips empty chapters and does not invent a destination for an empty or fully shown book', () => {
 const withEmpty = { ...content, chapters: [{ id: 'empty', title: 'Empty', paragraphs: [] }, ...content.chapters] };
 expect(firstUnshownLocation(summarizeReadingCoverage(withEmpty, []))).toEqual({ chapter: 1, paragraph: 0, offset: 0 });
 expect(firstUnshownLocation(summarizeReadingCoverage({ ...content, chapters: [] }, []))).toBeNull();
 expect(firstUnshownLocation(summarizeReadingCoverage({ ...content, chapters: [withEmpty.chapters[0]] }, []))).toBeNull();
});

it('keeps skipped chapters unseen and separates partial from full paragraphs', () => {
 expect(summarizeReadingCoverage(content, [row('p1', [[0, .2], [.8, 1]]), row('p2', [[.4, 1], [0, .5]])])).toEqual([
  { full: 1, partial: 1, unseen: 0, total: 2, firstIncomplete: 0, firstIncompleteOffset: .2 }, { full: 0, partial: 0, unseen: 1, total: 1, firstIncomplete: 0, firstIncompleteOffset: 0 },
 ]);
});
it('does not round away small gaps or count another edition, book, chapter or paragraph', () => {
 expect(summarizeReadingCoverage(content, [row('p1', [[0, .5], [.500001, 1]]), row('p2', [[0, 1]], { version: 'old' }), row('p2', [[0, 1]], { bookId: 'other' }), row('p3', [[0, 1]]), row('unknown', [[0, 1]])])).toEqual([
  { full: 0, partial: 1, unseen: 1, total: 2, firstIncomplete: 0, firstIncompleteOffset: .5 }, { full: 0, partial: 0, unseen: 1, total: 1, firstIncomplete: 0, firstIncompleteOffset: 0 },
 ]);
});
it('counts repeated observations once and leaves source ranges unchanged', () => {
 const rows = [row('p1', [[.5, 1], [0, .5]]), row('p1', [[0, 1]])];
 const before = structuredClone(rows);
 expect(summarizeReadingCoverage(content, rows)[0].full).toBe(1);
 expect(rows).toEqual(before);
});
it('updates the open summary after local and received fragments without touching queues or other owners', async () => {
 const store = new LocalDatabase(`summary-${crypto.randomUUID()}`);
 const other = new LocalDatabase(`summary-other-${crypto.randomUUID()}`, 'account:other');
 const snapshots: ReturnType<typeof summarizeReadingCoverage>[] = [];
 const subscription = liveQuery(async () => summarizeReadingCoverage(content, await store.coverage.where('[bookId+version]').equals(['book', '1']).toArray())).subscribe(value => snapshots.push(value));
 const wait = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(check()).toBe(true);
 };
 try {
  await wait(() => snapshots.length === 1);
  await saveReadingCoverage(content, [{ paragraph: 'p1', range: [0, .5] }], store);
  await wait(() => snapshots.at(-1)?.[0].partial === 1);
  const queue = await store.outbox.toArray();
  await store.coverage.put(row('p1', [[0, 1]], { queued: true }));
  await wait(() => snapshots.at(-1)?.[0].full === 1);
  await other.coverage.put(row('p3', [[0, 1]], { chapter: 'b' }));
  expect(snapshots.at(-1)?.[1].unseen).toBe(1);
  expect(await store.outbox.toArray()).toEqual(queue);
 } finally { subscription.unsubscribe(); await store.delete(); await other.delete(); }
});

it('finds the earliest incomplete paragraph in text order, including partial gaps, and stops offering fully shown chapters', () => {
 const rows = [row('p2', [[0, 1]])];
 expect(summarizeReadingCoverage(content, rows)[0].firstIncomplete).toBe(0);
 rows.push(row('p1', [[0, .4], [.400001, 1]]));
 expect(summarizeReadingCoverage(content, rows)[0].firstIncomplete).toBe(0);
 rows.push(row('p1', [[.4, .400001]]));
 expect(summarizeReadingCoverage(content, rows)[0].firstIncomplete).toBeNull();
 expect(summarizeReadingCoverage(content, [row('p1', [[0, 1]])])[0].firstIncomplete).toBe(1);
 expect(summarizeReadingCoverage({ ...content, chapters: [{ id: 'empty', title: 'Empty', paragraphs: [] }] }, [])[0].firstIncomplete).toBeNull();
});


it('targets the first missing prefix, internal gap or suffix without skipping tiny gaps', () => {
 const target = (ranges: ParagraphCoverage['ranges']) => summarizeReadingCoverage(content, [row('p1', ranges)])[0].firstIncompleteOffset;
 expect(target([])).toBe(0);
 expect(target([[.2, 1]])).toBe(0);
 expect(target([[0, .4], [.8, 1]])).toBe(.4);
 expect(target([[0, .999999]])).toBe(.999999);
 expect(target([[0, .4], [.400001, 1]])).toBe(.4);
 expect(target([[.8, 1], [0, .3], [.2, .6]])).toBe(.6);
 const joined = summarizeReadingCoverage(content, [row('p1', [[0, .3]]), row('p1', [[.2, 1]]), row('p2', [[0, .7]])])[0];
 expect(joined.firstIncomplete).toBe(1);
 expect(joined.firstIncompleteOffset).toBe(.7);
 const complete = summarizeReadingCoverage(content, [row('p1', [[0, 1]]), row('p2', [[0, 1]])])[0];
 expect(complete.firstIncomplete).toBeNull();
 expect(complete.firstIncompleteOffset).toBeNull();
});
