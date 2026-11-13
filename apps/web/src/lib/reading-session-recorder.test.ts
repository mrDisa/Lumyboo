import 'fake-indexeddb/auto';
import { expect, it, vi } from 'vitest';
import { LocalDatabase, saveReadingSession, type ReadingSession } from './db';
import { createReadingSessionRecorder } from './reading-session-recorder';

const session = (id: string, seconds: number, day = '2026-11-13'): ReadingSession => ({ id, seconds, day, bookId: 'book', version: '1' });
function deferred() {
 let resolve!: () => void; let reject!: (error: Error) => void;
 const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
 return { promise, resolve, reject };
}
it('retries failed totals after a chapter/dialog restart and day rollover without adding them twice', async () => {
 const save = vi.fn().mockRejectedValueOnce(new Error('Disk full')).mockResolvedValue(undefined);
 const recorder = createReadingSessionRecorder(save);
 recorder.record(session('chapter-1', 12.345));
 await expect(recorder.flush()).rejects.toThrow('Disk full');
 recorder.record(session('after-dialog', 4));
 recorder.record(session('next-day', 2, '2026-11-14'));
 await recorder.flush(); await recorder.flush();
 expect(save.mock.calls.map(call => call[0])).toEqual([
  session('chapter-1', 12.345), session('chapter-1', 12.345), session('after-dialog', 4), session('next-day', 2, '2026-11-14'),
 ]);
});
it('drains newer cumulative totals and split sessions before joined final flushes finish', async () => {
 const first = deferred(); const last = deferred();
 const save = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValueOnce(undefined).mockImplementationOnce(() => last.promise);
 const recorder = createReadingSessionRecorder(save);
 recorder.record(session('full', 86399));
 const tick = recorder.flush(); await Promise.resolve();
 recorder.record(session('full', 86400)); recorder.record(session('overflow', .75));
 let closed = false;
 const exit = recorder.flush().then(() => { closed = true; });
 expect(save).toHaveBeenCalledOnce(); first.resolve();
 await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(3));
 expect(closed).toBe(false);
 expect(save.mock.calls.map(call => call[0].seconds)).toEqual([86399, 86400, .75]);
 last.resolve(); await Promise.all([tick, exit]); expect(closed).toBe(true);
});
it('rejects every joined flush on failure and keeps later totals for an explicit retry', async () => {
 const gate = deferred(); const save = vi.fn().mockImplementationOnce(() => gate.promise).mockResolvedValue(undefined);
 const recorder = createReadingSessionRecorder(save);
 recorder.record(session('same', 1));
 const tick = expect(recorder.flush()).rejects.toThrow('Write failed'); await Promise.resolve();
 recorder.record(session('same', 2));
 const exit = expect(recorder.flush()).rejects.toThrow('Write failed');
 gate.reject(new Error('Write failed')); await Promise.all([tick, exit]);
 expect(save).toHaveBeenCalledOnce(); await recorder.flush();
 expect(save.mock.calls[1][0]).toEqual(session('same', 2));
});
it('keeps only the maximum pending snapshot, copies inputs and isolates reader buffers', async () => {
 const gate = deferred(); const save = vi.fn(() => gate.promise); const otherSave = vi.fn(async () => {});
 const recorder = createReadingSessionRecorder(save); const other = createReadingSessionRecorder(otherSave);
 const input = session('a', 3); recorder.record(input); input.seconds = 10;
 const pending = recorder.flush(); await Promise.resolve();
 recorder.record(session('a', 2)); recorder.record(session('a', 3)); recorder.record(session('empty', 0));
 gate.resolve(); await pending; await other.flush();
 expect(save).toHaveBeenCalledOnce(); expect(save).toHaveBeenCalledWith(session('a', 3));
 expect(otherSave).not.toHaveBeenCalled();
});
it('rejects invalid totals and changed session identity without replacing retry data', async () => {
 const save = vi.fn(async () => {}); const recorder = createReadingSessionRecorder(save);
 recorder.record(session('a', 2));
 for (const seconds of [NaN, Infinity, -1, 86400.001]) expect(() => recorder.record(session('a', seconds))).toThrow('Некорректное');
 for (const change of [{ day: '2026-11-14' }, { version: '2' }, { bookId: 'other' }, { deviceId: 'other' }]) {
  expect(() => recorder.record({ ...session('a', 3), ...change })).toThrow('изменились');
 }
 await recorder.flush(); expect(save).toHaveBeenCalledWith(session('a', 2));
});
it('retries synchronous exceptions and retains only uncommitted sessions after a partial drain', async () => {
 const save = vi.fn().mockImplementationOnce(() => { throw new Error('Unavailable'); }).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Later failure')).mockResolvedValue(undefined);
 const recorder = createReadingSessionRecorder(save);
 recorder.record(session('first', 1)); await expect(recorder.flush()).rejects.toThrow('Unavailable');
 recorder.record(session('second', 2)); await expect(recorder.flush()).rejects.toThrow('Later failure');
 await recorder.flush();
 expect(save.mock.calls.map(call => call[0].id)).toEqual(['first', 'first', 'second', 'second']);
});
it('recovers an atomic IndexedDB/outbox failure across session rollover and reopen', async () => {
 const store = new LocalDatabase(crypto.randomUUID(), 'account:time-retry');
 const guest = new LocalDatabase(crypto.randomUUID(), 'guest');
 const recorder = createReadingSessionRecorder(row => saveReadingSession(row, store));
 const put = vi.spyOn(store.outbox, 'add').mockRejectedValueOnce(new Error('Disk full'));
 try {
  recorder.record(session('old', 60.001)); await expect(recorder.flush()).rejects.toThrow('Disk full');
  expect(await store.sessions.count()).toBe(0); expect(await store.outbox.count()).toBe(0);
  recorder.record(session('new', 1.999, '2026-11-14')); await recorder.flush();
  store.close(); await store.open();
  const rows = await store.sessions.toArray();
  expect(rows.map(row => row.seconds).sort((a, b) => a - b)).toEqual([1.999, 60.001]);
  expect(new Set(rows.map(row => row.deviceId)).size).toBe(1); expect(rows[0].deviceId).toBeTruthy();
  const operations = await store.outbox.toArray();
  expect(operations).toHaveLength(2);
  expect(operations.every(op => op.scope === 'account:time-retry' && op.change.type === 'session.put')).toBe(true);
  expect(await guest.sessions.count()).toBe(0); expect(await guest.outbox.count()).toBe(0);
 } finally { put.mockRestore(); await store.delete(); await guest.delete(); }
});
it('keeps reader ownership until both the in-flight time and later session have committed', async () => {
 const { ownReading, readingLockName } = await import('./reading-ownership');
 const { locks } = await vi.importActual<{ locks: LockManager }>('node:worker_threads');
 vi.stubGlobal('navigator', { locks });
 const bookId = crypto.randomUUID(); const first = deferred(); const last = deferred();
 const save = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => last.promise);
 const recorder = createReadingSessionRecorder(save); const ready = vi.fn(); const onError = vi.fn();
 const close = ownReading('guest', bookId, recorder.flush, ready, vi.fn(), onError);
 try {
  await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
  recorder.record(session('first', 3)); const tick = recorder.flush(); await Promise.resolve();
  recorder.record(session('last', 2)); close(); first.resolve();
  await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  await locks.request(readingLockName('guest', bookId), { ifAvailable: true }, lock => expect(lock).toBeNull());
  last.resolve(); await tick;
  await vi.waitFor(async () => {
   await locks.request(readingLockName('guest', bookId), { ifAvailable: true }, lock => expect(lock).not.toBeNull());
  });
  expect(onError).not.toHaveBeenCalled();
 } finally { first.resolve(); last.resolve(); close(); vi.unstubAllGlobals(); }
});
