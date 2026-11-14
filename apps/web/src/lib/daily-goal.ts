import type { LocalDatabase } from './db';
import { localDay, sumReadingSeconds } from './reading';

export const goalOptions = [5, 10, 20, 30, 60] as const;
export interface DailyGoal {
 id: 'local';
 timeZone: string;
 changes: { from: string; minutes: number }[];
}
export function goalDay(timeZone: string, date = new Date()) { return localDay(date, timeZone); }
export function nextGoalDay(day: string) {
 const date = new Date(`${day}T12:00:00Z`);
 date.setUTCDate(date.getUTCDate() + 1);
 return date.toISOString().slice(0, 10);
}
export function goalMinutes(goal: DailyGoal, day: string) {
 return goal.changes.filter(row => row.from <= day).sort((a, b) => b.from.localeCompare(a.from))[0]?.minutes ?? 20;
}
export async function ensureDailyGoal(store: LocalDatabase, date = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
 return store.transaction('rw', store.dailyGoals, async () => {
  const saved = await store.dailyGoals.get('local');
  if (saved) return saved;
  const value: DailyGoal = { id: 'local', timeZone, changes: [{ from: goalDay(timeZone, date), minutes: 20 }] };
  await store.dailyGoals.put(value);
  return value;
 });
}
export async function chooseDailyGoal(store: LocalDatabase, minutes: number, date = new Date()) {
 if (!goalOptions.some(value => value === minutes)) throw new Error('Выбери цель из списка.');
 await ensureDailyGoal(store, date);
 return store.transaction('rw', store.dailyGoals, async () => {
  const goal = (await store.dailyGoals.get('local'))!;
  const from = nextGoalDay(goalDay(goal.timeZone, date));
  // Replacing tomorrow's choice never edits today's or past targets.
  const value = { ...goal, changes: [...goal.changes.filter(row => row.from !== from), { from, minutes }].sort((a, b) => a.from.localeCompare(b.from)) };
  await store.dailyGoals.put(value);
 });
}
export async function loadDailyProgress(store: LocalDatabase, goal: DailyGoal, day: string) {
 const seconds = sumReadingSeconds(await store.sessions.where('day').equals(day).toArray());
 const minutes = goalMinutes(goal, day);
 return { seconds, minutes, remaining: Math.max(0, Math.ceil(minutes * 60 - seconds)), complete: seconds >= minutes * 60 };
}
