import { ApiError } from './api';
import type { AccountSession } from './auth';

export type ReadingTimeAutoState = { accountId: string; phase: 'waiting' | 'saving' | 'offline' | 'paused'; message: string };
type Dependencies = {
 accountId: string;
 online: () => boolean;
 hasWork: () => Promise<boolean>;
 verify: (signal: AbortSignal) => Promise<AccountSession | null>;
 send: (session: AccountSession, signal: AbortSignal) => Promise<number>;
 publish: (state: ReadingTimeAutoState) => void;
};
export class ReadingTimeBusyError extends Error {}
function retryDelay(error: unknown, failures: number) {
 if (error instanceof ReadingTimeBusyError) return 5000;
 if (error instanceof TypeError || error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name) || error instanceof ApiError && (error.status === 429 || error.status >= 500)) {
  return Math.max(Math.min(5000 * 2 ** Math.min(failures - 1, 6), 300_000), error instanceof ApiError ? Math.min(error.retryAfter * 1000, 2_147_483_647) : 0);
 }
 return null;
}
// Only reading time is automatic. Position/bookmark conflicts still require a
// choice. Never infer a new owner, and never restart a stopped sender.
export function startReadingTimeAuto(deps: Dependencies) {
 const controller = new AbortController();
 let timer: ReturnType<typeof setTimeout> | undefined;
 let running = false; let paused = false; let failures = 0;
 const publish = (phase: ReadingTimeAutoState['phase'], message: string) => {
  if (!controller.signal.aborted) deps.publish({ accountId: deps.accountId, phase, message });
 };
 const schedule = (delay: number) => { if (!controller.signal.aborted && !paused) timer = setTimeout(() => { timer = undefined; void run(); }, delay); };
 async function run() {
  if (controller.signal.aborted || running || paused) return;
  if (!deps.online()) { publish('offline', 'Время остаётся на устройстве. Отправим при восстановлении сети.'); return; }
  running = true;
  let delay: number | null = 30_000;
  try {
   if (await deps.hasWork()) {
    if (controller.signal.aborted) return;
    publish('saving', 'Сохраняем время в аккаунте…');
    const session = await deps.verify(controller.signal);
    if (controller.signal.aborted) return;
    if (!session || session.user.id !== deps.accountId) throw new ApiError('Нужно снова войти в этот аккаунт, чтобы сохранить время.', 401, 'account_changed');
    const sent = await deps.send(session, controller.signal);
    // Yield between bounded batches; later snapshots remain in the queue.
    if (sent === 50) delay = 1000;
   }
   failures = 0;
   publish('waiting', 'Время чтения сохраняется автоматически, пока приложение открыто.');
  } catch (error) {
   if (controller.signal.aborted) return;
   delay = retryDelay(error, ++failures);
   paused = delay === null;
   publish(paused ? 'paused' : 'waiting', paused ? `Автосохранение времени остановлено. ${error instanceof Error ? error.message : 'Попробуй сохранить время вручную.'}` : 'Не удалось сохранить время. Записи на устройстве; повторим отправку позже.');
  } finally { running = false; if (!controller.signal.aborted && delay !== null) schedule(delay); }
 }
 void run();
 return {
  // online events cannot bypass an existing backoff or an account/conflict stop.
  wake() { if (!timer && !running && !paused) void run(); },
  resume() { if (controller.signal.aborted) return; paused = false; failures = 0; if (timer) clearTimeout(timer); timer = undefined; if (!running) void run(); },
  stop() { controller.abort(); if (timer) clearTimeout(timer); timer = undefined; },
 };
}
