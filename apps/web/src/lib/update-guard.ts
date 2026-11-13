const LOCK_NAME = 'lumyboo-reading-update';

// Shared reader locks prevent activation while any tab is reading or saving.
export function protectReading(
  save: () => Promise<void>,
  onReady: () => void,
  onError: (error: unknown) => void,
): () => void {
  if (!navigator.locks) {
    onReady();
    return () => { void save().catch(onError); };
  }
  const abort = new AbortController();
  let acquired = false;
  let disposed = false;
  let release!: () => void;
  const closed = new Promise<void>(resolve => { release = resolve; });
  void navigator.locks.request(LOCK_NAME, { mode: 'shared', signal: abort.signal }, async () => {
    if (disposed) return;
    acquired = true;
    onReady();
    await closed;
  }).catch(error => {
    if (!disposed) onError(error);
  });
  return () => {
    disposed = true;
    if (!acquired) { abort.abort(); return; }
    // Keep protection on a write failure. Closing the tab releases the browser lock;
    // an automatic update must never turn a failed save into an unnoticed reload.
    void save().then(release, onError);
  };
}

export async function withUpdateProtection(update: () => Promise<void>): Promise<void> {
  if (!navigator.locks) throw new Error('Для безопасного обновления закрой все вкладки Lumyboo и открой приложение снова.');
  await navigator.locks.request(LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) throw new Error('В другой вкладке открыта книга или сохраняется чтение. Заверши чтение и повтори обновление.');
    await update();
  });
}
