import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ownReading } from './reading-ownership';

beforeEach(async () => {
 const { locks } = await vi.importActual<{ locks: LockManager }>('node:worker_threads');
 const prefix = crypto.randomUUID();
 vi.stubGlobal('navigator', { locks: { request: (name: string, options: LockOptions, callback: LockGrantedCallback<unknown>) => locks.request(prefix + name, options, callback) } });
});
afterEach(() => { vi.unstubAllGlobals(); });
function deferred() {
 let resolve!: () => void;
 const promise = new Promise<void>(done => { resolve = done; });
 return { promise, resolve };
}
function open(scope: 'guest' | `account:${string}` = 'guest', book = 'book', save: () => Promise<void> = async () => {}) {
 const ready = vi.fn(); const busy = vi.fn(); const error = vi.fn();
 const close = ownReading(scope, book, save, ready, busy, error);
 return { ready, busy, error, close };
}
it('blocks a second reader before it can load or write the same local book', async () => {
 const first = open(); await vi.waitFor(() => expect(first.ready).toHaveBeenCalledOnce());
 const second = open();
 await vi.waitFor(() => expect(second.busy).toHaveBeenCalledOnce());
 expect(second.ready).not.toHaveBeenCalled(); expect(second.error).not.toHaveBeenCalled();
 second.close(); first.close();
});
it('keeps ownership until final persistence finishes and retry reads the new position', async () => {
 const saved = deferred(); let position = 'chapter 1';
 const save = vi.fn(async () => { await saved.promise; position = 'chapter 2'; });
 const first = open('guest', 'book', save);
 await vi.waitFor(() => expect(first.ready).toHaveBeenCalledOnce()); first.close(); first.close();
 const blocked = open(); await vi.waitFor(() => expect(blocked.busy).toHaveBeenCalledOnce()); blocked.close();
 expect(save).toHaveBeenCalledOnce(); expect(position).toBe('chapter 1');
 saved.resolve();
 await vi.waitFor(() => expect(position).toBe('chapter 2'));
 const read = vi.fn(() => expect(position).toBe('chapter 2'));
 const close = ownReading('guest', 'book', async () => {}, read, vi.fn(), vi.fn());
 await vi.waitFor(() => expect(read).toHaveBeenCalledOnce()); close();
});
it('separates books and guest/account owners', async () => {
 const readers = [open(), open('guest', 'another-book'), open('account:a'), open('account:b')];
 await vi.waitFor(() => readers.forEach(reader => expect(reader.ready).toHaveBeenCalledOnce()));
 readers.forEach(reader => { expect(reader.busy).not.toHaveBeenCalled(); reader.close(); });
});
it('cancels opening before acquisition without saving or showing an error', async () => {
 const save = vi.fn(); const reader = open('guest', 'book', save); reader.close();
 await new Promise(resolve => setTimeout(resolve, 10));
 expect(reader.ready).not.toHaveBeenCalled(); expect(reader.error).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
 const next = open(); await vi.waitFor(() => expect(next.ready).toHaveBeenCalledOnce()); next.close();
});
it('supports effect setup/cleanup/setup without rejecting its own replacement', async () => {
 const cancelled = open(); cancelled.close();
 const active = open(); await vi.waitFor(() => expect(active.ready).toHaveBeenCalledOnce());
 expect(cancelled.ready).not.toHaveBeenCalled(); expect(active.busy).not.toHaveBeenCalled(); active.close();
});
it('does not flush the rejected reader when it closes', async () => {
 const first = open(); await vi.waitFor(() => expect(first.ready).toHaveBeenCalledOnce());
 const save = vi.fn(); const second = open('guest', 'book', save);
 await vi.waitFor(() => expect(second.busy).toHaveBeenCalledOnce()); second.close();
 expect(save).not.toHaveBeenCalled(); first.close();
});
it('reports final save errors and keeps the lock until the owning tab closes', async () => {
 const first = open('guest', 'book', async () => { throw new Error('storage full'); });
 await vi.waitFor(() => expect(first.ready).toHaveBeenCalledOnce()); first.close();
 await vi.waitFor(() => expect(first.error).toHaveBeenCalledWith(expect.objectContaining({ message: 'storage full' })));
 const second = open(); await vi.waitFor(() => expect(second.busy).toHaveBeenCalledOnce()); second.close();
});
it('requires safe ownership when Web Locks are unavailable', () => {
 vi.stubGlobal('navigator', {});
 const reader = open(); expect(reader.error).toHaveBeenCalledOnce(); expect(reader.ready).not.toHaveBeenCalled(); reader.close();
});
it('reports acquisition errors without opening the reader', async () => {
 vi.stubGlobal('navigator', { locks: { request: vi.fn().mockRejectedValue(new Error('lock denied')) } });
 const reader = open(); await vi.waitFor(() => expect(reader.error).toHaveBeenCalledOnce());
 expect(reader.ready).not.toHaveBeenCalled(); reader.close();
});
