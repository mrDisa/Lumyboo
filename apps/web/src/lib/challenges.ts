import type { components } from './api.generated';
import { ApiError, requestJSON } from './api';
import { getSession } from './auth';
import { authGeneration } from './local-account';
export type Challenge = components['schemas']['Challenge'];
export type CreateChallenge = components['schemas']['CreateChallenge'];
export type Conditions = Omit<CreateChallenge, 'accountId' | 'operationId'>;
const key = (owner: string) => `lumyboo-challenge-pending:${owner}`;
function assertOwner(expected: string, actual: string | undefined, generation: string | null) {
 if (expected !== actual || generation !== authGeneration()) throw new Error('Аккаунт изменился. Проверь вход заново.');
}
export function pendingChallenge(owner: string): CreateChallenge | null {
 const raw = sessionStorage.getItem(key(owner));
 if (!raw) return null;
 const value: CreateChallenge = JSON.parse(raw);
 if (value.accountId !== owner || typeof value.operationId !== 'string') throw new Error('Не удалось прочитать сохранённый запрос создания.');
 return value;
}
export async function listChallenges(owner: string, signal?: AbortSignal): Promise<Challenge[]> {
 const generation = authGeneration();
 const result = await requestJSON<{ accountId: string; items: Challenge[] }>(`/challenges?accountId=${encodeURIComponent(owner)}`, { signal });
 assertOwner(owner, result.accountId, generation);
 return result.items;
}
// Persist the exact request before sending. A lost response or reload retries
// the same operation, never a new challenge with edited conditions.
export async function createChallenge(owner: string, conditions?: Conditions): Promise<Challenge> {
 const generation = authGeneration();
 const session = await getSession();
 assertOwner(owner, session?.user.id, generation);
 let pending = pendingChallenge(owner);
 if (!pending) {
  if (!conditions) throw new Error('Заполни условия челленджа.');
  pending = { ...conditions, accountId: owner, operationId: crypto.randomUUID() };
  sessionStorage.setItem(key(owner), JSON.stringify(pending));
 }
 let result: { accountId: string; challenge: Challenge };
 try {
  result = await requestJSON('/challenges', { method: 'POST', headers: { 'X-CSRF-Token': session!.csrfToken }, body: JSON.stringify(pending) });
 } catch (error) {
  // A rejected payload was never stored; transport errors remain retryable.
  if (error instanceof ApiError && error.status === 400 && generation === authGeneration()) sessionStorage.removeItem(key(owner));
  throw error;
 }
 assertOwner(owner, result.accountId, generation);
 sessionStorage.removeItem(key(owner));
 return result.challenge;
}
