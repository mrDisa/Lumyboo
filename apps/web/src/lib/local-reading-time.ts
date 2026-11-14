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

export async function loadLocalReadingDay(store: LocalDatabase, day: string) {
 const sessions = await store.sessions.where('day').equals(day).toArray();
 const editions = new Map<string, { bookId: string; version?: string; milliseconds: number }>();
 for (const session of sessions) {
  const milliseconds = Math.round(session.seconds * 1000);
  if (milliseconds <= 0) continue;
  const key = JSON.stringify([session.bookId, session.version ?? null]);
  const row = editions.get(key) ?? { bookId: session.bookId, version: session.version, milliseconds: 0 };
  row.milliseconds += milliseconds;
  editions.set(key, row);
 }
 return {
  milliseconds: [...editions.values()].reduce((sum, row) => sum + row.milliseconds, 0),
  editions: [...editions.values()].sort((a, b) => b.milliseconds - a.milliseconds || a.bookId.localeCompare(b.bookId) || (a.version ?? '').localeCompare(b.version ?? '')),
 };
}
