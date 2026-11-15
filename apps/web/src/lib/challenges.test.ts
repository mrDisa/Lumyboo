import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('./auth', () => ({ getSession: vi.fn() }));
vi.mock('./local-account', () => ({ authGeneration: vi.fn(() => 'generation') }));
import { getSession } from './auth';
import { authGeneration } from './local-account';
import { createChallenge, listChallenges, pendingChallenge, type Conditions } from './challenges';
const conditions: Conditions = { name: 'Together', nickname: 'Reader', mode: 'competitive', minutes: 20, duration: 7, timeZone: 'UTC', startDay: '2026-11-16' };
const session = { user: { id: 'a', email: 'a@example.test' }, csrfToken: 'csrf' };
const item = { ...conditions, id: 'saved' };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
beforeEach(() => {
 const values = new Map<string, string>();
 vi.stubGlobal('sessionStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
 vi.mocked(getSession).mockResolvedValue(session); vi.mocked(authGeneration).mockReturnValue('generation');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('retries an immutable operation after loss and a module reload', async () => {
 const fetch = vi.fn().mockRejectedValueOnce(new TypeError('lost')).mockResolvedValueOnce(response({ accountId: 'a', challenge: item })); vi.stubGlobal('fetch', fetch);
 await expect(createChallenge('a', conditions)).rejects.toThrow();
 const pending = pendingChallenge('a'); expect(pending?.name).toBe('Together');
 vi.resetModules(); const reloaded = await import('./challenges');
 expect(await reloaded.createChallenge('a', { ...conditions, minutes: 5 })).toEqual(item);
 const requests = fetch.mock.calls.map(call => JSON.parse(call[1].body));
 expect(requests[0]).toEqual(requests[1]); expect(requests[1].minutes).toBe(20);
 expect(reloaded.pendingChallenge('a')).toBeNull(); expect(pendingChallenge('b')).toBeNull();
});
it('checks the signed-in owner before creating and rejects wrong-owner responses', async () => {
 const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
 await expect(createChallenge('b', conditions)).rejects.toThrow('Аккаунт изменился'); expect(fetch).not.toHaveBeenCalled();
 fetch.mockResolvedValue(response({ accountId: 'b', challenge: item }));
 await expect(createChallenge('a', conditions)).rejects.toThrow('Аккаунт изменился'); expect(pendingChallenge('a')).not.toBeNull();
});
it('keeps pending creation on authorization errors and permits editing a rejected payload', async () => {
 const fetch = vi.fn().mockResolvedValueOnce(response({ error: { code: 'invalid_csrf', message: 'Refresh' } }, 403)).mockResolvedValueOnce(response({ error: { code: 'invalid_challenge', message: 'Invalid' } }, 400));vi.stubGlobal('fetch', fetch);
 await expect(createChallenge('a', conditions)).rejects.toThrow('Refresh'); expect(pendingChallenge('a')).not.toBeNull();
 await expect(createChallenge('a')).rejects.toThrow('Invalid'); expect(pendingChallenge('a')).toBeNull();
});
it('does not send a mutation when persisting the retry fails', async () => {
 vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => { throw new Error('Storage blocked'); });
 const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
 await expect(createChallenge('a', conditions)).rejects.toThrow('Storage blocked'); expect(fetch).not.toHaveBeenCalled();
});
it('guards lists against account changes and requests only the expected owner', async () => {
 const fetch = vi.fn().mockResolvedValue(response({ accountId: 'a', items: [item] }));vi.stubGlobal('fetch', fetch);
 expect(await listChallenges('a')).toEqual([item]); expect(fetch.mock.calls[0][0]).toBe('/api/v1/challenges?accountId=a');
 fetch.mockImplementation(async () => { vi.mocked(authGeneration).mockReturnValue('changed'); return response({ accountId: 'a', items: [item] }); });
 await expect(listChallenges('a')).rejects.toThrow('Аккаунт изменился');
});
it('guards challenge actions against account switches before and after sending', async () => {
 const { challengeAction } = await import('./challenges');
 const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
 await expect(challengeAction('b', { kind: 'invite', challengeId: 'id' })).rejects.toThrow('Аккаунт изменился'); expect(fetch).not.toHaveBeenCalled();
 fetch.mockResolvedValue(response({ accountId: 'b', challenge: item, code: 'secret' }));
 await expect(challengeAction('a', { kind: 'invite', challengeId: 'id' })).rejects.toThrow('Аккаунт изменился');
 fetch.mockImplementation(async () => { vi.mocked(authGeneration).mockReturnValue('changed'); return response({ accountId: 'a', challenge: item, code: 'secret' }); });
 await expect(challengeAction('a', { kind: 'invite', challengeId: 'id' })).rejects.toThrow('Аккаунт изменился');
});
it('sends explicit join conditions with CSRF and can retry after a lost reply', async () => {
 const { challengeAction } = await import('./challenges');
 const result = { accountId: 'a', challenge: item, code: '' };
 const fetch = vi.fn().mockRejectedValueOnce(new TypeError('lost')).mockResolvedValueOnce(response(result)); vi.stubGlobal('fetch', fetch);
 const action = { kind: 'join' as const, code: 'a'.repeat(48), nickname: 'Friend', minutes: 5 as const };
 await expect(challengeAction('a', action)).rejects.toThrow();
 expect(await challengeAction('a', action)).toEqual(result);
 const request = fetch.mock.calls[1]; expect(request[0]).toBe('/api/v1/challenges/action');
 expect(JSON.parse(request[1].body)).toEqual({ ...action, accountId: 'a' }); expect(new Headers(request[1].headers).get('X-CSRF-Token')).toBe('csrf');
 expect(fetch.mock.calls[0][1].body).toBe(request[1].body);
});
