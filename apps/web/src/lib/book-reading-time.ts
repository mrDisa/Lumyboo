import type { LocalDatabase } from './db';
import { sumReadingSeconds } from './reading';

// Read only this owner's saved snapshots. Server history is deliberately not
// added: it can contain these same sessions and would double their time.
export async function loadBookReadingTime(store: LocalDatabase, bookId: string, version: string, day: string) {
 const sessions = await store.sessions.where('bookId').equals(bookId).filter(row => row.version === version).toArray();
 return {
  total: sumReadingSeconds(sessions),
  today: sumReadingSeconds(sessions.filter(row => row.day === day)),
 };
}
