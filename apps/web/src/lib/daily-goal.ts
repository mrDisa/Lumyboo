import type { LocalDatabase } from './db';
import { localDay, sumReadingSeconds } from './reading';

export const goalOptions = [5, 10, 20, 30, 60] as const;
export interface DailyGoal {
 id: 'local';
 revision?: number;
 pending?: import('./account-daily-goal').PendingGoalChange;
 timeZone: string;
 changes: { from: string; minutes: number }[];
}
export function goalDay(timeZone: string, date = new Date()) { return localDay(date, timeZone); }
export function nextGoalDay(day: string) {
 const date = new Date(`${day}T12:00:00Z`);
 date.setUTCDate(date.getUTCDate() + 1);
 return date.toISOString().slice(0, 10);
}
export function goalMinutes(goal: Pick<DailyGoal, 'changes'>, day: string) {
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
 const sessions = await store.sessions.where('day').belowOrEqual(day).toArray();
 const seconds = sumReadingSeconds(sessions.filter(row => row.day === day));
 const totals = new Map<string, number>();
 for (const row of sessions) totals.set(row.day, (totals.get(row.day) ?? 0) + Math.round(row.seconds * 1000));
 const completed = new Set([...totals].filter(([date, ms]) => ms >= goalMinutes(goal, date) * 60000).map(([date]) => date));
 let cursor = day;
 if (!completed.has(cursor)) cursor = previousGoalDay(cursor);
 let streak = 0;
 while (completed.has(cursor)) { streak++; cursor = previousGoalDay(cursor); }
 const minutes = goalMinutes(goal, day);
 return { seconds, minutes, streak, remaining: Math.max(0, Math.ceil(minutes * 60 - seconds)), complete: seconds >= minutes * 60 };
}

function previousGoalDay(day: string) {
 const date = new Date(`${day}T12:00:00Z`);
 date.setUTCDate(date.getUTCDate() - 1);
 return date.toISOString().slice(0, 10);
}
