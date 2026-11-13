import { useEffect, useSyncExternalStore } from 'react';
import { useAccount, getSession } from '../lib/auth';
import { accountDatabase } from '../lib/account-reading';
import { sendReadingCoverage } from '../lib/reading-coverage-sync';
import { hasReadingCoverageWork, startReadingCoverageAuto } from '../lib/reading-coverage-auto';
import type { ReadingAutoState } from '../lib/reading-auto';

let state: ReadingAutoState | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function publish(next: ReadingAutoState | null) { state = next; listeners.forEach(listener => listener()); }
const resumeEvent = 'lumyboo-reading-coverage-resume';
export function resumeAutomaticReadingCoverage() { window.dispatchEvent(new Event(resumeEvent)); }
export function useAutomaticReadingCoverage(accountId: string) {
 const current = useSyncExternalStore(subscribe, () => state);
 return current?.accountId === accountId ? current : null;
}
export function AutomaticReadingCoverage() {
 const { session } = useAccount();
 const accountId = session?.user.id;
 useEffect(() => {
  if (!accountId) { publish(null); return; }
  const store = accountDatabase(accountId);
  const sender = startReadingCoverageAuto({
   accountId, online: () => navigator.onLine,
   hasWork: () => hasReadingCoverageWork(store),
   verify: getSession,
   send: (liveSession, signal) => sendReadingCoverage(store, liveSession, signal), publish,
  });
  const wake = () => sender.wake(); const resume = () => sender.resume();
  window.addEventListener('online', wake); window.addEventListener(resumeEvent, resume);
  return () => { sender.stop(); window.removeEventListener('online', wake); window.removeEventListener(resumeEvent, resume); publish(null); };
 }, [accountId]);
 return null;
}
