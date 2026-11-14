import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import type { LocalDatabase } from './db';
import { prepareDailyGoal } from './account-daily-goal';
import { type DailyGoal } from './daily-goal';

export function useDailyGoal(store: LocalDatabase) {
 const [state, setState] = useState<{ goal?: DailyGoal; error?: boolean }>({});
 const [attempt, retry] = useState(0);
 useEffect(() => {
  let disposed = false;
  let subscription: { unsubscribe: () => void } | undefined;
  setState({});
  void prepareDailyGoal(store).then(() => {
   if (disposed) return;
   subscription = liveQuery(() => store.dailyGoals.get('local')).subscribe({
    next: goal => setState({ goal }), error: () => setState({ error: true }),
   });
  }).catch(() => { if (!disposed) setState({ error: true }); });
  return () => { disposed = true; subscription?.unsubscribe(); };
 }, [store, attempt]);
 return { ...state, retry: () => retry(value => value + 1) };
}
