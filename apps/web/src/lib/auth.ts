import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { components } from './api.generated';
import { ApiError, requestJSON } from './api';
export type AccountSession = components['schemas']['AccountSession'];
export type LoginChallenge = components['schemas']['LoginChallenge'];
const sessionKey = ['auth', 'session'] as const;
const eventKey = 'lumyboo-auth-changed';
export function requestCode(email: string) { return requestJSON<LoginChallenge>('/auth/code', { method: 'POST', body: JSON.stringify({ email }) }); }
export function verifyCode(challengeId: string, code: string) { return requestJSON<AccountSession>('/auth/verify', { method: 'POST', body: JSON.stringify({ challengeId, code }) }); }
export async function getSession(signal?: AbortSignal): Promise<AccountSession | null> {
 try { return await requestJSON<AccountSession>('/auth/session', { signal }); }
 catch (error) { if (error instanceof ApiError && error.status === 401) return null; throw error; }
}
function announceChange() {
 const id = crypto.randomUUID();
 try { const channel = new BroadcastChannel(eventKey); channel.postMessage(id); channel.close(); } catch { /* Storage events remain available in browsers without BroadcastChannel. */ }
 try { localStorage.setItem(eventKey, id); } catch { /* No account information is stored here. */ }
}
export function useAccount() {
 const client = useQueryClient();
 const query = useQuery({ queryKey: sessionKey, queryFn: ({ signal }) => getSession(signal), retry: false, staleTime: 0, gcTime: 0, networkMode: 'always' });
 const refresh = async () => {
  await client.cancelQueries({ queryKey: sessionKey });
  client.setQueryData(sessionKey, null);
  await client.invalidateQueries({ queryKey: sessionKey });
 };
 useEffect(() => {
  let last = '';
  const receive = (id: unknown) => { if (typeof id !== 'string' || id === last) return; last = id; void refresh(); };
  const storage = (event: StorageEvent) => { if (event.key === eventKey) receive(event.newValue); };
  let channel: BroadcastChannel | undefined;
  try { channel = new BroadcastChannel(eventKey); channel.onmessage = event => receive(event.data); } catch { /* Listen to storage events below. */ }
  window.addEventListener('storage', storage);
  return () => { channel?.close(); window.removeEventListener('storage', storage); };
 }, [client]);
 async function verified(challengeId: string, code: string) {
  try { await verifyCode(challengeId, code); }
  finally { announceChange(); await refresh(); }
 }
 async function logout(all = false, expectedAccountId?: string) {
  try {
   const session = await getSession();
   if (session && expectedAccountId && session.user.id !== expectedAccountId) throw new ApiError('Аккаунт изменился. Открой профиль заново.', 409, 'account_changed');
   if (session) await requestJSON<void>(all ? '/auth/logout-all' : '/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': session.csrfToken } });
  } finally {
   // The server may have changed the shared cookie before its response was
   // lost. Other tabs must recheck even when this tab cannot confirm success.
   announceChange();
   await refresh();
  }
 }
 // Hide stale personal details as soon as a refresh starts or fails.
 return { session: query.isSuccess && !query.isFetching ? query.data : null, checking: query.isPending || query.isFetching, error: query.error, verified, logout };
}
