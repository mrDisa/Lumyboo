import type { ReadingSession } from './db';

// One buffer per open reader/database, surviving chapter and dialog effects.
// Snapshots are cumulative: retry the latest total, never add it a second time.
export function createReadingSessionRecorder(save: (session: ReadingSession) => Promise<void>) {
 const pending = new Map<string, ReadingSession>();
 let inFlight: Promise<void> | undefined;
 function record(session: ReadingSession) {
  if (!Number.isFinite(session.seconds) || session.seconds < 0 || session.seconds > 86400) throw new Error('Некорректное время чтения.');
  const previous = pending.get(session.id);
  if (previous && (previous.bookId !== session.bookId || previous.version !== session.version || previous.day !== session.day || previous.deviceId !== session.deviceId)) throw new Error('Данные сессии чтения изменились.');
  if (session.seconds > (previous?.seconds ?? 0)) pending.set(session.id, { ...session });
 }
 async function flush(): Promise<void> {
  if (inFlight) { await inFlight; return flush(); }
  if (!pending.size) return;
  const snapshot = new Map(pending);
  inFlight = Promise.resolve().then(async () => {
   for (const [id, session] of snapshot) {
    await save({ ...session });
    // A later tick can replace this snapshot while its write is pending.
    if (pending.get(id) === session) pending.delete(id);
   }
  }).finally(() => { inFlight = undefined; });
  await inFlight;
  return flush();
 }
 return { record, flush };
}
