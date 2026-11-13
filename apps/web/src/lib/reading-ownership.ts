import type { OperationScope } from './db';

export const readingLockName = (scope: OperationScope, bookId: string) => `lumyboo-reader:${JSON.stringify([scope, bookId])}`;

// Acquire before loading/reconciling the local locator, not just before the
// first save. A waiting reader must load the position after the previous one
// has flushed, rather than keep a stale snapshot from its initial opening.
export function ownReading(
 scope: OperationScope, bookId: string, save: () => Promise<void>,
 onReady: () => void, onBusy: () => void, onError: (error: unknown) => void,
): () => void {
 if (!navigator.locks) {
  onError(new Error('Не удалось защитить место чтения. Открой приложение в обновлённом браузере по HTTPS или на localhost.'));
  return () => {};
 }
 let acquired = false; let disposed = false;
 let release!: () => void;
 const closed = new Promise<void>(resolve => { release = resolve; });
 const name = readingLockName(scope, bookId);
 // Defer the request so a cancelled effect (including StrictMode's initial
 // replay) cannot briefly occupy the lock and reject its own replacement.
 void Promise.resolve().then(() => {
  if (disposed) return;
  return navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, async lock => {
   if (disposed) return;
   if (!lock) { onBusy(); return; }
   acquired = true;
   onReady();
   await closed;
  });
 }).catch(error => { if (!disposed) onError(error); });
 return () => {
  if (disposed) return;
  disposed = true;
  if (!acquired) return;
  // Preserve ownership on a failed write. Closing the tab releases the lock;
  // another reader must not open an older locator while this save is pending.
  void Promise.resolve().then(save).then(release, onError);
 };
}
