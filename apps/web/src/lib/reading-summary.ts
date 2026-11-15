import type { LocalDatabase, ReadingSession } from './db';
import { ensureDailyGoal, goalDay, loadDailyProgress } from './daily-goal';
import { sumReadingSeconds } from './reading';

// Only snapshots committed by this open reader belong to its session result.
// Daily progress already includes these records; the two totals must not be added.
export async function loadReadingSummary(store: LocalDatabase, sessions: ReadingSession[], now = new Date()) {
 const goal = await ensureDailyGoal(store, now);
 const day = goalDay(goal.timeZone, now);
 const progress = await loadDailyProgress(store, goal, day);
 const days = [...new Set(sessions.map(row => row.day))].sort().map(day => ({
  day, milliseconds: Math.round(sumReadingSeconds(sessions.filter(row => row.day === day)) * 1000),
 }));
 return { day, timeZone: goal.timeZone, progress, days, milliseconds: Math.round(sumReadingSeconds(sessions) * 1000) };
}
export type ReadingSummaryData = Awaited<ReturnType<typeof loadReadingSummary>>;
