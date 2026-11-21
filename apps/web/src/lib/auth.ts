import { staticHost } from './hosting';
import { randomId } from './random-id';
import { useEffect, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { components } from './api.generated';
import { ApiError, requestJSON } from './api';
import { authChangeKey, authGeneration, isConnectionFailure, localAccountSnapshot, readLocalAccount, rememberLocalAccount, subscribeLocalAccount } from './local-account';
export type AccountSession = components['schemas']['AccountSession'];
export type LoginChallenge = components['schemas']['LoginChallenge'];
const sessionKey = ['auth', 'session'] as const;
const eventKey = authChangeKey;
export function requestCode(email: string) { return requestJSON<LoginChallenge>('/auth/code', { method: 'POST', body: JSON.stringify({ email }) }); }
export function verifyCode(challengeId: string, code: string) { return requestJSON<AccountSession>('/auth/verify', { method: 'POST', body: JSON.stringify({ challengeId, code }) }); }
export async function getSession(signal?: AbortSignal): Promise<AccountSession | null> {
 if (staticHost) return null;
 const generation = authGeneration();
 try {
  const session = await requestJSON<AccountSession>('/auth/session', { signal });
  if (generation !== authGeneration()) throw new Error('Аккаунт изменился. Проверь вход заново.');
  rememberLocalAccount(session.user);
  return session;
 } catch (error) {
  if (error instanceof ApiError && error.status === 401) { if (generation === authGeneration()) rememberLocalAccount(null); return null; }
  throw error;
 }
}
function announceChange() {
 const id = randomId();
 try { const channel = new BroadcastChannel(eventKey); channel.postMessage(id); channel.close(); } catch { /* Storage events remain available in browsers without BroadcastChannel. */ }
 try { localStorage.setItem(eventKey, id); } catch { /* No account information is stored here. */ }
}
export function useAccount() {
 useSyncExternalStore(subscribeLocalAccount, localAccountSnapshot, () => null);
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
  rememberLocalAccount(null); announceChange();
  try { await verifyCode(challengeId, code); }
  finally { rememberLocalAccount(null); announceChange(); await refresh(); }
 }
 async function logout(all = false, expectedAccountId?: string) {
  rememberLocalAccount(null); announceChange();
  try {
   const session = await getSession();
   rememberLocalAccount(null);
   if (session && expectedAccountId && session.user.id !== expectedAccountId) throw new ApiError('Аккаунт изменился. Открой профиль заново.', 409, 'account_changed');
   if (session) await requestJSON<void>(all ? '/auth/logout-all' : '/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': session.csrfToken } });
  } finally {
   // The server may have changed the shared cookie before its response was
   // lost. Other tabs must recheck even when this tab cannot confirm success.
   rememberLocalAccount(null);
   announceChange();
   await refresh();
  }
 }
 // Hide stale personal details as soon as a refresh starts or fails.
 return { session: query.isSuccess && !query.isFetching ? query.data : null, checking: query.isPending || query.isFetching, error: query.error, localAccount: query.isError && !query.isFetching && isConnectionFailure(query.error) ? readLocalAccount() : null, forgetLocal: () => { rememberLocalAccount(null); announceChange(); }, verified, logout };
}
