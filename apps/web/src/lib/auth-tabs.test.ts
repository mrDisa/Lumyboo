import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAccount } from './auth';

// Run the hook's actions and subscriptions with two independent tab clients.
// React rendering is not needed to verify session invalidation and ordering.
const harness = vi.hoisted(() => ({
 client: {} as Record<string, ReturnType<typeof vi.fn>>,
 effects: [] as Array<() => void>,
}));
vi.mock('react', () => ({ useEffect: (effect: () => void) => harness.effects.push(effect) }));
vi.mock('@tanstack/react-query', () => ({
 useQueryClient: () => harness.client,
 useQuery: () => ({ isSuccess: true, isFetching: false, data: null }),
}));

const listeners = new Set<(event: { data: unknown }) => void>();
class Channel {
 onmessage: ((event: { data: unknown }) => void) | null = null;
 constructor(_name: string) { listeners.add(this.receive); }
 receive = (event: { data: unknown }) => this.onmessage?.(event);
 postMessage(data: unknown) { for (const receive of listeners) if (receive !== this.receive) receive({ data }); }
 close() { listeners.delete(this.receive); }
}
function tab() {
 const client = {
  cancelQueries: vi.fn().mockResolvedValue(undefined),
  setQueryData: vi.fn(),
  invalidateQueries: vi.fn().mockResolvedValue(undefined),
 };
 harness.client = client;
 const account = useAccount();
 harness.effects.splice(0).forEach(effect => effect());
 return { account, client };
}
beforeEach(() => {
 vi.stubGlobal('BroadcastChannel', Channel);
 vi.stubGlobal('localStorage', { setItem: vi.fn() });
 vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => { listeners.clear(); harness.effects = []; vi.unstubAllGlobals(); });

it.each(['verify', 'logout', 'logout-all'] as const)('invalidates the other tab after a lost %s response', async action => {
 const session = { user: { id: 'account-a' }, csrfToken: 'csrf-a' };
 const fetch = vi.fn();
 if (action !== 'verify') fetch.mockResolvedValueOnce(new Response(JSON.stringify(session)));
 // The server may have committed the mutation; the browser cannot know.
 fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
 vi.stubGlobal('fetch', fetch);
 const a = tab(); const b = tab();
 await expect(action === 'verify'
  ? a.account.verified('challenge', '123456')
  : a.account.logout(action === 'logout-all', 'account-a')).rejects.toBeInstanceOf(TypeError);
 await vi.waitFor(() => expect(b.client.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['auth', 'session'] }));
 for (const client of [a.client, b.client]) {
  expect(client.setQueryData).toHaveBeenCalledWith(['auth', 'session'], null);
  expect(client.cancelQueries.mock.invocationCallOrder[0]).toBeLessThan(client.setQueryData.mock.invocationCallOrder[0]);
  expect(client.setQueryData.mock.invocationCallOrder[0]).toBeLessThan(client.invalidateQueries.mock.invocationCallOrder[0]);
 }
 expect(localStorage.setItem).toHaveBeenCalledWith('lumyboo-auth-changed', expect.any(String));
 expect(fetch.mock.calls.at(-1)?.[0]).toBe(`/api/v1/auth/${action}`);
});

it('uses storage events when BroadcastChannel is unavailable after an uncertain logout', async () => {
 vi.stubGlobal('BroadcastChannel', class { constructor() { throw new Error('unavailable'); } });
 const session = { user: { id: 'account-a' }, csrfToken: 'csrf-a' };
 vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(session))).mockRejectedValueOnce(new TypeError('lost')));
 const a = tab(); const b = tab();
 await expect(a.account.logout()).rejects.toBeInstanceOf(TypeError);
 const [key, newValue] = vi.mocked(localStorage.setItem).mock.calls[0];
 const storage = vi.mocked(window.addEventListener).mock.calls.filter(call => call[0] === 'storage')[1]?.[1] as EventListener;
 storage({ key, newValue } as StorageEvent);
 await vi.waitFor(() => expect(b.client.invalidateQueries).toHaveBeenCalled());
});
