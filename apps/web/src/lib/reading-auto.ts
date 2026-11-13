import { ApiError } from './api';
import type { AccountSession } from './auth';

export type ReadingAutoState = { accountId: string; phase: 'waiting' | 'saving' | 'offline' | 'paused'; message: string };
export type ReadingAutoDependencies = {
 accountId: string;
 online: () => boolean;
 hasWork: () => Promise<boolean>;
 verify: (signal: AbortSignal) => Promise<AccountSession | null>;
 send: (session: AccountSession, signal: AbortSignal) => Promise<number>;
 publish: (state: ReadingAutoState) => void;
};
export type ReadingAutoMessages = Record<'offline' | 'saving' | 'signIn' | 'waiting' | 'paused' | 'manual' | 'retry', string>;
export class ReadingAutoBusyError extends Error {}
function retryDelay(error: unknown, failures: number) {
 if (error instanceof ReadingAutoBusyError) return 5000;
 if (error instanceof TypeError || error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name) || error instanceof ApiError && (error.status === 429 || error.status >= 500)) {
  return Math.max(Math.min(5000 * 2 ** Math.min(failures - 1, 6), 300_000), error instanceof ApiError ? Math.min(error.retryAfter * 1000, 2_147_483_647) : 0);
 }
 return null;
}
// Bounded account-only sender. Never infer an owner or restart after cleanup.
export function startReadingAuto(deps: ReadingAutoDependencies, messages: ReadingAutoMessages, options: { once?: boolean } = {}) {
 const controller = new AbortController();
 let timer: ReturnType<typeof setTimeout> | undefined;
 let running = false; let paused = false; let failures = 0; let completed = false;
 const publish = (phase: ReadingAutoState['phase'], message: string) => {
  if (!controller.signal.aborted) deps.publish({ accountId: deps.accountId, phase, message });
 };
 const schedule = (delay: number) => { if (!controller.signal.aborted && !paused) timer = setTimeout(() => { timer = undefined; void run(); }, delay); };
 async function run() {
  if (controller.signal.aborted || running || paused || completed) return;
  if (!deps.online()) { publish('offline', messages.offline); return; }
  running = true;
  let delay: number | null = 30_000;
  try {
   if (await deps.hasWork()) {
    if (controller.signal.aborted) return;
    publish('saving', messages.saving);
    const session = await deps.verify(controller.signal);
    if (controller.signal.aborted) return;
    if (!session || session.user.id !== deps.accountId) throw new ApiError(messages.signIn, 401, 'account_changed');
    const sent = await deps.send(session, controller.signal);
    // Yield between bounded batches; later snapshots remain in the queue.
    if (sent === 50) delay = 1000;
    if (options.once) { completed = true; delay = null; }
   }
   failures = 0;
   publish('waiting', messages.waiting);
  } catch (error) {
   if (controller.signal.aborted) return;
   delay = retryDelay(error, ++failures);
   paused = delay === null;
   publish(paused ? 'paused' : 'waiting', paused ? `${messages.paused} ${error instanceof Error ? error.message : messages.manual}` : messages.retry);
  } finally { running = false; if (!controller.signal.aborted && delay !== null) schedule(delay); }
 }
 void run();
 return {
  // online events cannot bypass an existing backoff or an account/conflict stop.
  wake() { if (!timer && !running && !paused) void run(); },
  // A new foreground visit may refresh a successful one-shot receive. It must
  // never bypass an active run, retry delay or permanent validation/auth stop.
  refresh() { if (controller.signal.aborted || !completed) return; completed = false; void run(); },
  resume() { if (controller.signal.aborted) return; paused = false; failures = 0; if (timer) clearTimeout(timer); timer = undefined; if (!running) void run(); },
  stop() { controller.abort(); if (timer) clearTimeout(timer); timer = undefined; },
 };
}
