import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { liveQuery } from 'dexie';
import type { BookContent } from './books';
import { LocalDatabase } from './db';
import { saveReadingCoverage, type ParagraphCoverage } from './reading-coverage';
import { summarizeReadingCoverage } from './reading-coverage-summary';

const content: BookContent = { id: 'book', version: '1', chapters: [
 { id: 'a', title: 'A', paragraphs: [{ id: 'p1', text: 'One' }, { id: 'p2', text: 'Two' }] },
 { id: 'b', title: 'B', paragraphs: [{ id: 'p3', text: 'Three' }] },
] };
const row = (paragraph: string, ranges: ParagraphCoverage['ranges'], patch: Partial<ParagraphCoverage> = {}): ParagraphCoverage => ({ bookId: 'book', version: '1', chapter: 'a', paragraph, ranges, ...patch });

it('keeps skipped chapters unseen and separates partial from full paragraphs', () => {
 expect(summarizeReadingCoverage(content, [row('p1', [[0, .2], [.8, 1]]), row('p2', [[.4, 1], [0, .5]])])).toEqual([
  { full: 1, partial: 1, unseen: 0, total: 2 }, { full: 0, partial: 0, unseen: 1, total: 1 },
 ]);
});
it('does not round away small gaps or count another edition, book, chapter or paragraph', () => {
 expect(summarizeReadingCoverage(content, [row('p1', [[0, .5], [.500001, 1]]), row('p2', [[0, 1]], { version: 'old' }), row('p2', [[0, 1]], { bookId: 'other' }), row('p3', [[0, 1]]), row('unknown', [[0, 1]])])).toEqual([
  { full: 0, partial: 1, unseen: 1, total: 2 }, { full: 0, partial: 0, unseen: 1, total: 1 },
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
