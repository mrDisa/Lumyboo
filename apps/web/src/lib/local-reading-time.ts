import type { LocalDatabase, ReadingSession } from './db';
import { sumReadingSeconds } from './reading';

export function summarizeReadingTime(sessions: ReadingSession[], day: string) {
 const dailyMilliseconds = new Map<string, number>();
 for (const session of sessions) {
  const milliseconds = Math.round(session.seconds * 1000);
  if (milliseconds > 0) dailyMilliseconds.set(session.day, (dailyMilliseconds.get(session.day) ?? 0) + milliseconds);
 }
 return {
  total: sumReadingSeconds(sessions),
  today: sumReadingSeconds(sessions.filter(row => row.day === day)),
  days: [...dailyMilliseconds].sort(([a], [b]) => b.localeCompare(a)).map(([day, milliseconds]) => ({ day, seconds: milliseconds / 1000 })),
 };
}

export function loadLocalReadingTime(store: LocalDatabase, day: string) {
 return store.transaction('r', store.sessions, store.bookmarks, async () => ({
  ...summarizeReadingTime(await store.sessions.toArray(), day),
  bookmarks: await store.bookmarks.count(),
 }));
}
