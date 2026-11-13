import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalDatabase } from './db';
import { mergeTextRanges, sampleVisibleText, saveReadingCoverage, visibleTextRanges } from './reading-coverage';
import type { BookContent } from './books';
const content: BookContent = { id: 'book', version: '1', chapters: [
 { id: 'first', title: 'First', paragraphs: [{ id: 'p1', text: 'One' }, { id: 'p2', text: 'Two' }] },
 { id: 'last', title: 'Last', paragraphs: [{ id: 'p3', text: 'Three' }] },
] };
const stores: LocalDatabase[] = [];
function database(scope: 'guest' | `account:${string}` = 'guest', name: string = crypto.randomUUID()) {
 const store = new LocalDatabase(name, scope); stores.push(store); return store;
}
afterEach(async () => { for (const store of stores) await store.delete(); stores.length = 0; vi.unstubAllGlobals(); });
it('clips to actual visible fractions without including skipped or hidden paragraphs', () => {
 expect(visibleTextRanges([
  { id: 'above', top: -100, bottom: 0 }, { id: 'p1', top: 0, bottom: 200 },
  { id: 'p2', top: 200, bottom: 400 }, { id: 'below', top: 400, bottom: 600 },
 ], 100, 300)).toEqual([{ paragraph: 'p1', range: [.5, 1] }, { paragraph: 'p2', range: [0, .5] }]);
 expect(visibleTextRanges([{ id: 'p', top: 0, bottom: 0 }], 0, 100)).toEqual([]);
 expect(visibleTextRanges([{ id: 'p', top: 0, bottom: 100 }], 100, 0)).toEqual([]);
 expect(visibleTextRanges([{ id: 'p', top: NaN, bottom: 100 }], 0, 100)).toEqual([]);
 expect(visibleTextRanges([{ id: 'p', top: 0, bottom: 3 }], 1, 2)).toEqual([{ paragraph: 'p', range: [.333334, .666666] }]);
});
it('unions overlapping and adjacent ranges while preserving unseen gaps', () => {
 const ranges: [number, number][] = [[.7, .8], [0, .2], [.1, .3], [.3, .4], [0, .2]];
 expect(mergeTextRanges(ranges)).toEqual([[0, .4], [.7, .8]]);
 expect(ranges).toEqual([[.7, .8], [0, .2], [.1, .3], [.3, .4], [0, .2]]);
});
it('persists exact disjoint fragments across reopen, without changing position, time or queue', async () => {
 const store = database();
 await saveReadingCoverage(content, [{ paragraph: 'p1', range: [0, .2] }, { paragraph: 'p1', range: [.8, 1] }, { paragraph: 'p3', range: [0, 1] }], store);
 store.close(); await store.open();
 await saveReadingCoverage(content, [{ paragraph: 'p1', range: [0, .2] }], store);
 expect(await store.coverage.get(['book', '1', 'p1'])).toEqual({ bookId: 'book', version: '1', chapter: 'first', paragraph: 'p1', ranges: [[0, .2], [.8, 1]] });
 expect(await store.coverage.get(['book', '1', 'p2'])).toBeUndefined();
 expect(await store.coverage.get(['book', '1', 'p3'])).toMatchObject({ chapter: 'last', ranges: [[0, 1]] });
 expect(await store.positions.count()).toBe(0); expect(await store.sessions.count()).toBe(0); expect(await store.outbox.count()).toBe(0);
});
it('isolates editions, books, guests and accounts even with identical paragraph IDs', async () => {
 const guest = database(); const account = database('account:a'); const other = database('account:b');
 await saveReadingCoverage(content, [{ paragraph: 'p1', range: [0, 1] }], guest);
 await saveReadingCoverage({ ...content, version: '2' }, [{ paragraph: 'p1', range: [0, .1] }], guest);
 await saveReadingCoverage({ ...content, id: 'other' }, [{ paragraph: 'p1', range: [.5, 1] }], guest);
 await saveReadingCoverage(content, [{ paragraph: 'p1', range: [.2, .3] }], account);
 expect((await guest.coverage.get(['book', '1', 'p1']))?.ranges).toEqual([[0, 1]]);
 expect((await guest.coverage.get(['book', '2', 'p1']))?.ranges).toEqual([[0, .1]]);
 expect((await guest.coverage.get(['other', '1', 'p1']))?.ranges).toEqual([[.5, 1]]);
 expect((await account.coverage.get(['book', '1', 'p1']))?.ranges).toEqual([[.2, .3]]);
 expect(await other.coverage.count()).toBe(0);
});
it('merges concurrent writes from separate database connections without losing ranges', async () => {
 const a = database(); const b = database('guest', a.name);
 await Promise.all([
  saveReadingCoverage(content, [{ paragraph: 'p1', range: [0, .2] }], a),
  saveReadingCoverage(content, [{ paragraph: 'p1', range: [.8, 1] }], b),
 ]);
 expect((await a.coverage.get(['book', '1', 'p1']))?.ranges).toEqual([[0, .2], [.8, 1]]);
 b.close();
});
it('does not rewrite unchanged observations or create empty coverage', async () => {
 const store = database();
 await saveReadingCoverage(content, [], store);
 expect(await store.coverage.count()).toBe(0);
 await saveReadingCoverage(content, [{ paragraph: 'p1', range: [0, 1] }], store);
 const put = vi.spyOn(store.coverage, 'put');
 try {
  await saveReadingCoverage(content, [{ paragraph: 'p1', range: [.2, .4] }, { paragraph: 'p1', range: [0, 1] }], store);
  expect(put).not.toHaveBeenCalled();
 } finally { put.mockRestore(); }
});
it('rejects unknown locators and rolls back a batch containing invalid fractions', async () => {
 const store = database();
 await expect(saveReadingCoverage(content, [{ paragraph: 'missing', range: [0, 1] }], store)).rejects.toThrow('отсутствует');
 for (const range of [[-1, 1], [0, 2], [.5, .5], [1, 0], [NaN, 1], [0, Infinity]] as [number, number][]) {
  await expect(saveReadingCoverage(content, [{ paragraph: 'p1', range: [0, 1] }, { paragraph: 'p2', range }], store)).rejects.toThrow('Некорректный');
  expect(await store.coverage.count()).toBe(0);
 }
});
it('rolls back a storage failure and retries the same observation safely', async () => {
 const store = database();
 const put = vi.spyOn(store.coverage, 'put').mockRejectedValueOnce(new Error('Disk full'));
 const samples = [{ paragraph: 'p1', range: [0, 1] as [number, number] }];
 await expect(saveReadingCoverage(content, samples, store)).rejects.toThrow('Disk full');
 expect(await store.coverage.count()).toBe(0);
 put.mockRestore(); await saveReadingCoverage(content, samples, store);
 expect(await store.coverage.count()).toBe(1);
});
it('upgrades a v5 account database without fabricating earlier coverage', async () => {
 const name = crypto.randomUUID(); const old = new Dexie(name);
 old.version(5).stores({ settings: 'id', positions: 'bookId', bookmarks: 'id, bookId', shelf: 'bookId', downloads: 'bookId', sessions: 'id, day, bookId', positionHistory: 'id, bookId, [bookId+version]', outbox: 'id, sequence, [entity+state]', metadata: 'id', positionChoices: 'bookId', bookmarkChoices: 'id' });
 try {
  await old.table('sessions').put({ id: 'old', bookId: 'book', day: '2026-11-13', seconds: 60 }); old.close();
  const upgraded = database('account:a', name);
  expect(await upgraded.sessions.get('old')).toMatchObject({ seconds: 60 });
  expect(await upgraded.coverage.count()).toBe(0);
 } finally { old.close(); }
});
it('excludes the sticky header, clipped screen and browser viewport from sampling', () => {
 vi.stubGlobal('window', { innerHeight: 450 });
 const paragraph = (id: string, top: number, bottom: number) => ({ id, getBoundingClientRect: () => ({ top, bottom }) });
 const screen = { getBoundingClientRect: () => ({ top: -20, bottom: 600 }), querySelector: () => ({ getBoundingClientRect: () => ({ bottom: 100 }) }), querySelectorAll: () => [paragraph('p1', 0, 200), paragraph('p2', 400, 500)] } as unknown as HTMLElement;
 expect(sampleVisibleText(screen)).toEqual([{ paragraph: 'p1', range: [.5, 1] }, { paragraph: 'p2', range: [0, .5] }]);
});
