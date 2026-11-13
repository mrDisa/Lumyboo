import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { ReadingTimeBusyError, startReadingTimeAuto, type ReadingTimeAutoState } from './reading-time-auto';
import { startReadingCoverageAuto } from './reading-coverage-auto';
describe.each([['time', startReadingTimeAuto], ['coverage', startReadingCoverageAuto]] as const)('%s automatic saving', (_name, start) => {
const accountId = 'account-a';
const session = { user: { id: accountId, email: 'a@example.test' }, csrfToken: 'fresh' };
const active: ReturnType<typeof startReadingTimeAuto>[] = [];
function setup(overrides: Partial<Parameters<typeof startReadingTimeAuto>[0]> = {}) {
 vi.useFakeTimers();
 const deps = { accountId, online: vi.fn(() => true), hasWork: vi.fn(async () => true), verify: vi.fn(async () => session), send: vi.fn(async () => 1), publish: vi.fn<(state: ReadingTimeAutoState) => void>(), ...overrides };
 const sender = start(deps); active.push(sender);
 return { ...deps, sender };
}
afterEach(() => { active.forEach(sender => sender.stop()); active.length = 0; vi.useRealTimers(); });
it('verifies a live owner on opening and before each subsequent batch', async () => {
 const deps = setup(); await vi.advanceTimersByTimeAsync(0);
 expect(deps.verify).toHaveBeenCalledOnce(); expect(deps.send).toHaveBeenCalledWith(session, expect.any(AbortSignal));
 await vi.advanceTimersByTimeAsync(30_000); expect(deps.verify).toHaveBeenCalledTimes(2); expect(deps.send).toHaveBeenCalledTimes(2);
});
it('does not check sessions or send when there is no eligible account work', async () => {
 const deps = setup({ hasWork: vi.fn(async () => false) }); await vi.advanceTimersByTimeAsync(60_000);
 expect(deps.verify).not.toHaveBeenCalled(); expect(deps.send).not.toHaveBeenCalled();
});
it('waits offline and wakes when the network returns', async () => {
 let online = false; const deps = setup({ online: () => online });
 await vi.advanceTimersByTimeAsync(60_000); expect(deps.send).not.toHaveBeenCalled();
 expect(deps.publish).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'offline' }));
 online = true; deps.sender.wake(); await vi.advanceTimersByTimeAsync(0); expect(deps.send).toHaveBeenCalledOnce();
});
it('backs off lost responses exponentially, without online-event storms bypassing the delay', async () => {
 const send = vi.fn(async () => { throw new TypeError('Lost response'); }); const deps = setup({ send });
 await vi.advanceTimersByTimeAsync(0); expect(send).toHaveBeenCalledOnce();
 for (let i = 0; i < 10; i++) deps.sender.wake();
 await vi.advanceTimersByTimeAsync(4999); expect(send).toHaveBeenCalledOnce();
 await vi.advanceTimersByTimeAsync(1); expect(send).toHaveBeenCalledTimes(2);
 await vi.advanceTimersByTimeAsync(9999); expect(send).toHaveBeenCalledTimes(2);
 await vi.advanceTimersByTimeAsync(1); expect(send).toHaveBeenCalledTimes(3);
});
it('respects Retry-After and retries server timeouts', async () => {
 const send = vi.fn().mockRejectedValueOnce(new ApiError('Limited', 429, 'limited', 60)).mockRejectedValueOnce(new DOMException('timeout', 'TimeoutError')).mockResolvedValue(1);
 setup({ send }); await vi.advanceTimersByTimeAsync(59_999); expect(send).toHaveBeenCalledOnce();
 await vi.advanceTimersByTimeAsync(1); expect(send).toHaveBeenCalledTimes(2);
 await vi.advanceTimersByTimeAsync(10_000); expect(send).toHaveBeenCalledTimes(3);
});
it('pauses on auth, account changes, conflicts, invalid receipts and local storage failures', async () => {
 for (const error of [new ApiError('Sign in', 401, 'auth'), new ApiError('CSRF', 403, 'csrf'), new ApiError('Conflict', 409, 'conflict'), new ApiError('Invalid', 422, 'invalid'), new Error('Invalid receipt'), new Error('Disk full')]) {
  const send = vi.fn(async () => { throw error; }); const deps = setup({ send });
  await vi.advanceTimersByTimeAsync(0); deps.sender.wake(); await vi.advanceTimersByTimeAsync(600_000);
  expect(send).toHaveBeenCalledOnce(); expect(deps.publish).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'paused' })); deps.sender.stop();
 }
});
it('never sends under a different or expired account', async () => {
 for (const live of [null, { ...session, user: { ...session.user, id: 'account-b' } }]) {
  const deps = setup({ verify: vi.fn(async () => live) }); await vi.advanceTimersByTimeAsync(60_000);
  expect(deps.send).not.toHaveBeenCalled(); expect(deps.publish).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'paused' })); deps.sender.stop();
 }
});
it('yields after a full batch then checks the session again', async () => {
 const send = vi.fn().mockResolvedValueOnce(50).mockResolvedValue(1); const deps = setup({ send });
 await vi.advanceTimersByTimeAsync(999); expect(send).toHaveBeenCalledOnce();
 await vi.advanceTimersByTimeAsync(1); expect(send).toHaveBeenCalledTimes(2); expect(deps.verify).toHaveBeenCalledTimes(2);
});
it('retries another-tab contention without overlapping batches', async () => {
 const send = vi.fn().mockRejectedValueOnce(new ReadingTimeBusyError('Busy')).mockResolvedValue(1); const deps = setup({ send });
 await vi.advanceTimersByTimeAsync(0); deps.sender.wake(); await vi.advanceTimersByTimeAsync(5000); expect(send).toHaveBeenCalledTimes(2);
});
it('stops after unmount during session verification and ignores late completion', async () => {
 let finish!: (value: typeof session) => void;
 const deps = setup({ verify: vi.fn(() => new Promise<typeof session>(resolve => { finish = resolve; })) });
 await vi.advanceTimersByTimeAsync(0); deps.sender.stop(); const calls = vi.mocked(deps.publish).mock.calls.length;
 finish(session); await vi.advanceTimersByTimeAsync(60_000); deps.sender.resume(); deps.sender.wake();
 expect(deps.send).not.toHaveBeenCalled(); expect(deps.publish).toHaveBeenCalledTimes(calls);
});
it('aborts an in-flight send and leaves no timers after stop', async () => {
 let signal!: AbortSignal;
 const deps = setup({ send: vi.fn(async (_session, value) => { signal = value; await new Promise((_resolve, reject) => value.addEventListener('abort', () => reject(value.reason))); return 0; }) });
 await vi.advanceTimersByTimeAsync(0); deps.sender.stop(); await vi.advanceTimersByTimeAsync(60_000);
 expect(signal.aborted).toBe(true); expect(deps.send).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
it('can resume after explicit successful manual saving', async () => {
 const send = vi.fn().mockRejectedValueOnce(new Error('Invalid receipt')).mockResolvedValue(1); const deps = setup({ send });
 await vi.advanceTimersByTimeAsync(0); deps.sender.resume(); await vi.advanceTimersByTimeAsync(0); expect(send).toHaveBeenCalledTimes(2);
});

});
