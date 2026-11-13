import { useEffect, useSyncExternalStore } from 'react';
import { useAccount, getSession } from '../lib/auth';
import { accountDatabase } from '../lib/account-reading';
import { readingSessionReport, sendReadingSessions } from '../lib/reading-session-sync';
import { startReadingTimeAuto, type ReadingTimeAutoState } from '../lib/reading-time-auto';

let state: ReadingTimeAutoState | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function publish(next: ReadingTimeAutoState | null) { state = next; listeners.forEach(listener => listener()); }
const resumeEvent = 'lumyboo-reading-time-resume';
export function resumeAutomaticReadingTime() { window.dispatchEvent(new Event(resumeEvent)); }
export function useAutomaticReadingTime(accountId: string) {
 const current = useSyncExternalStore(subscribe, () => state);
 return current?.accountId === accountId ? current : null;
}
export function AutomaticReadingTime() {
 const { session } = useAccount();
 const accountId = session?.user.id;
 useEffect(() => {
  if (!accountId) { publish(null); return; }
  const store = accountDatabase(accountId);
  const sender = startReadingTimeAuto({
   accountId, online: () => navigator.onLine,
   hasWork: async () => (await store.outbox.toArray()).some(op => op.scope === store.scope && !!readingSessionReport(op)),
   verify: getSession,
   send: (liveSession, signal) => sendReadingSessions(store, liveSession, signal), publish,
  });
  const wake = () => sender.wake(); const resume = () => sender.resume();
  window.addEventListener('online', wake); window.addEventListener(resumeEvent, resume);
  return () => { sender.stop(); window.removeEventListener('online', wake); window.removeEventListener(resumeEvent, resume); publish(null); };
 }, [accountId]);
 return null;
}
