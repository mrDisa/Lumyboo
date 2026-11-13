import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { protectReading, withUpdateProtection } from './update-guard';

beforeEach(async () => {
  const { locks } = await vi.importActual<{ locks: LockManager }>('node:worker_threads');
  const prefix = crypto.randomUUID();
  const request = (name: string, options: LockOptions, callback: LockGrantedCallback<unknown>) => locks.request(prefix + name, options, callback);
  vi.stubGlobal('navigator', { locks: { request } });
});
afterEach(() => { vi.unstubAllGlobals(); });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
it('blocks activation across readers until every final save is confirmed', async () => {
  const firstReady = deferred(); const secondReady = deferred(); const saved = deferred();
  const error = vi.fn(); const update = vi.fn().mockResolvedValue(undefined);
  const closeFirst = protectReading(() => saved.promise, firstReady.resolve, error);
  const closeSecond = protectReading(async () => {}, secondReady.resolve, error);
  await Promise.all([firstReady.promise, secondReady.promise]);
  try {
    await expect(withUpdateProtection(update)).rejects.toThrow('открыта книга');
    closeFirst(); closeSecond();
    await expect(withUpdateProtection(update)).rejects.toThrow('сохраняется чтение');
    expect(update).not.toHaveBeenCalled();
  } finally { saved.resolve(); }
  await vi.waitFor(async () => { await withUpdateProtection(update); });
  expect(error).not.toHaveBeenCalled();
});
it('defers a new reader until update activation finishes', async () => {
  const activation = deferred(); const started = deferred(); const ready = vi.fn();
  const update = withUpdateProtection(async () => { started.resolve(); await activation.promise; });
  await started.promise;
  const close = protectReading(async () => {}, ready, vi.fn());
  expect(ready).not.toHaveBeenCalled();
  activation.resolve(); await update;
  await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce()); close();
});
it('cancels a reader that closes before an update finishes', async () => {
  const activation = deferred(); const started = deferred(); const ready = vi.fn(); const error = vi.fn();
  const update = withUpdateProtection(async () => { started.resolve(); await activation.promise; });
  await started.promise;
  const close = protectReading(async () => {}, ready, error); close();
  activation.resolve(); await update;
  await withUpdateProtection(async () => {});
  expect(ready).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
});
it('keeps protection and reports a failed final save', async () => {
  let settled = false;
  const request = vi.fn((_name: string, _options: LockOptions, callback: LockGrantedCallback<unknown>) => {
    return Promise.resolve(callback({} as Lock)).then(() => { settled = true; });
  });
  vi.stubGlobal('navigator', { locks: { request } });
  const ready = vi.fn(); const error = vi.fn();
  const close = protectReading(async () => { throw new Error('storage full'); }, ready, error);
  close();
  await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
  expect(ready).toHaveBeenCalledOnce(); expect(settled).toBe(false);
});
it('allows reading but does not force updates when Web Locks are unavailable', async () => {
  vi.stubGlobal('navigator', {}); const ready = vi.fn(); const saved = vi.fn().mockResolvedValue(undefined);
  const close = protectReading(saved, ready, vi.fn()); expect(ready).toHaveBeenCalledOnce(); close();
  await expect(withUpdateProtection(async () => {})).rejects.toThrow('закрой все вкладки');
  expect(saved).toHaveBeenCalledOnce();
});
