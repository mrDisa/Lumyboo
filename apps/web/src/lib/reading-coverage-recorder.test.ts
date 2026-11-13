import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { LocalDatabase } from './db';
import { createCoverageRecorder, saveReadingCoverage, type CoverageSample } from './reading-coverage';
const sample = (paragraph: string, from = 0, to = 1): CoverageSample => ({ paragraph, range: [from, to] });
function deferred() {
 let resolve!: () => void; let reject!: (error: Error) => void;
 const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
 return { promise, resolve, reject };
}
it('retains failed observations when the reader moves on and retries without a new observation', async () => {
 const save = vi.fn().mockRejectedValueOnce(new Error('Disk full')).mockResolvedValue(undefined);
 const recorder = createCoverageRecorder(save);
 recorder.observe([sample('first', 0, .2), sample('first', .8, 1)]);
 await expect(recorder.flush()).rejects.toThrow('Disk full');
 recorder.observe([sample('last')]);
 await recorder.flush();
 expect(save.mock.calls[1][0]).toEqual([sample('first', 0, .2), sample('first', .8, 1), sample('last')]);
 await recorder.flush(); expect(save).toHaveBeenCalledTimes(2);
});
it('keeps later same-paragraph observations while an earlier snapshot commits', async () => {
 const gate = deferred();
 const save = vi.fn().mockImplementationOnce(() => gate.promise).mockResolvedValue(undefined);
 const recorder = createCoverageRecorder(save);
 recorder.observe([sample('p', 0, .2)]);
 const pending = recorder.flush(); await Promise.resolve();
 recorder.observe([sample('p', .8, 1)]);
 gate.resolve(); await pending;
 expect(save.mock.calls.map(call => call[0])).toEqual([[sample('p', 0, .2)], [sample('p', 0, .2), sample('p', .8, 1)]]);
 await recorder.flush(); expect(save).toHaveBeenCalledTimes(2);
});
it('joins overlapping final flushes and waits for all observations without overlapping writes', async () => {
 const first = deferred(); const second = deferred();
 const save = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
 const recorder = createCoverageRecorder(save);
 recorder.observe([sample('chapter-1')]);
 const tick = recorder.flush(); await Promise.resolve();
 recorder.observe([sample('chapter-5')]);
 let closed = false;
 const exit = recorder.flush().then(() => { closed = true; });
 expect(save).toHaveBeenCalledOnce(); expect(closed).toBe(false);
 first.resolve();
 await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
 expect(closed).toBe(false);
 expect(save.mock.calls[1][0]).toEqual([sample('chapter-5')]);
 second.resolve(); await Promise.all([tick, exit]); expect(closed).toBe(true);
});
it('does not clear observations or report a successful final flush when a joined write fails', async () => {
 const gate = deferred(); const save = vi.fn().mockImplementationOnce(() => gate.promise).mockResolvedValue(undefined);
 const recorder = createCoverageRecorder(save);
 recorder.observe([sample('p', 0, .2)]);
 const tick = expect(recorder.flush()).rejects.toThrow('Write failed');
 await Promise.resolve(); recorder.observe([sample('p', .8, 1)]);
 const exit = expect(recorder.flush()).rejects.toThrow('Write failed');
 gate.reject(new Error('Write failed')); await Promise.all([tick, exit]);
 expect(save).toHaveBeenCalledOnce();
 await recorder.flush();
 expect(save.mock.calls[1][0]).toEqual([sample('p', 0, .2), sample('p', .8, 1)]);
});
it('does not resave identical observations added during an in-flight write', async () => {
 const gate = deferred(); const save = vi.fn(() => gate.promise);
 const recorder = createCoverageRecorder(save);
 recorder.observe([sample('p')]);
 const pending = recorder.flush(); await Promise.resolve();
 recorder.observe([sample('p', .2, .3)]);
 gate.resolve(); await pending;
 expect(save).toHaveBeenCalledOnce();
});
it('copies input values, rolls back invalid observations and remains scoped to one recorder', async () => {
 const save = vi.fn(async () => {}); const otherSave = vi.fn(async () => {});
 const recorder = createCoverageRecorder(save); const other = createCoverageRecorder(otherSave);
 const input = sample('p', 0, .2); recorder.observe([input]); input.range[1] = 1;
 expect(() => recorder.observe([sample('later'), sample('invalid', -1, 1)])).toThrow();
 await recorder.flush(); await other.flush();
 expect(save).toHaveBeenCalledWith([sample('p', 0, .2)]); expect(otherSave).not.toHaveBeenCalled();
});
it('retries a synchronous storage exception and a failure in a later drain', async () => {
 const gate = deferred();
 const save = vi.fn().mockImplementationOnce(() => { throw new Error('Unavailable'); }).mockImplementationOnce(() => gate.promise).mockRejectedValueOnce(new Error('Second write')).mockResolvedValue(undefined);
 const recorder = createCoverageRecorder(save);
 recorder.observe([sample('a')]); await expect(recorder.flush()).rejects.toThrow('Unavailable');
 const retry = expect(recorder.flush()).rejects.toThrow('Second write');
 await Promise.resolve(); recorder.observe([sample('b')]); gate.resolve(); await retry;
 await recorder.flush(); expect(save.mock.calls[3][0]).toEqual([sample('b')]);
});
it('recovers a failed IndexedDB write, preserves skipped chapters and survives reopen after commit', async () => {
 const store = new LocalDatabase(crypto.randomUUID(), 'account:coverage-retry');
 const content = { id: 'book', version: '1', chapters: [1, 2, 5].map(n => ({ id: `ch-${n}`, title: 'Chapter', paragraphs: [{ id: `p-${n}`, text: 'Text' }] })) };
 const recorder = createCoverageRecorder(samples => saveReadingCoverage(content, samples, store));
 const put = vi.spyOn(store.coverage, 'put').mockRejectedValueOnce(new Error('Temporary failure'));
 try {
  recorder.observe([sample('p-1', 0, .2)]); await expect(recorder.flush()).rejects.toThrow('Temporary failure');
  expect(await store.coverage.count()).toBe(0);
  recorder.observe([sample('p-5')]); await recorder.flush();
  store.close(); await store.open();
  expect((await store.coverage.get(['book', '1', 'p-1']))?.ranges).toEqual([[0, .2]]);
  expect((await store.coverage.get(['book', '1', 'p-5']))?.ranges).toEqual([[0, 1]]);
  expect(await store.coverage.get(['book', '1', 'p-2'])).toBeUndefined();
  expect(await store.outbox.count()).toBe(2);
 } finally { put.mockRestore(); await store.delete(); }
});
it('keeps reader ownership until the final coverage flush has drained later observations', async () => {
 const { ownReading, readingLockName } = await import('./reading-ownership');
 const { locks } = await vi.importActual<{ locks: LockManager }>('node:worker_threads');
 vi.stubGlobal('navigator', { locks });
 const bookId = crypto.randomUUID();
 const first = deferred(); const last = deferred();
 const save = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => last.promise);
 const recorder = createCoverageRecorder(save); const ready = vi.fn(); const onError = vi.fn();
 const close = ownReading('guest', bookId, recorder.flush, ready, vi.fn(), onError);
 try {
  await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
  recorder.observe([sample('first')]); const tick = recorder.flush(); await Promise.resolve();
  recorder.observe([sample('last')]); close();
  first.resolve(); await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  const busy = vi.fn(); const nextReady = vi.fn();
  const closeNext = ownReading('guest', bookId, async () => {}, nextReady, busy, onError);
  await vi.waitFor(() => expect(busy).toHaveBeenCalledOnce()); closeNext();
  expect(nextReady).not.toHaveBeenCalled();
  last.resolve(); await tick;
  await vi.waitFor(async () => {
   await locks.request(readingLockName('guest', bookId), { ifAvailable: true }, lock => expect(lock).not.toBeNull());
  });
  expect(onError).not.toHaveBeenCalled();
 } finally { first.resolve(); last.resolve(); close(); vi.unstubAllGlobals(); }
});
