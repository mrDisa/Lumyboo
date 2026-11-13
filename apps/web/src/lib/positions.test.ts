import { afterEach, expect, it, vi } from 'vitest';
import { chooseAccountPosition, loadAccountPositions, positionChoice, samePosition } from './positions';
const session = { user: { id: 'account-a', email: 'a@example.test' }, csrfToken: 'csrf-a' };
const local = { bookId: 'book', version: '1', chapter: 1, paragraph: 'p2', offset: .3, updatedAt: 'device-clock' };
afterEach(() => vi.unstubAllGlobals());
it('retries an uncertain choice with the same operation and displayed revision', async () => {
 const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('Network error')).mockResolvedValue(new Response(JSON.stringify({ accountId: 'account-a', position: { ...local, revision: 4 } })));
 vi.stubGlobal('fetch', fetcher);
 const choice = positionChoice(local, { ...local, chapter: 0, revision: 3 });
 await expect(chooseAccountPosition(session, choice)).rejects.toThrow('Network error');
 await chooseAccountPosition(session, choice);
 expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body);
 const body = JSON.parse(fetcher.mock.calls[0][1].body);
 expect(body).toEqual({ accountId: 'account-a', operationId: choice.operationId, expectedRevision: 3, position: { bookId: 'book', version: '1', chapter: 1, paragraph: 'p2', offset: .3 } });
 expect(fetcher.mock.calls[0][1].headers.get('X-CSRF-Token')).toBe('csrf-a');
});
it('surfaces stale-revision conflicts without automatically overwriting them', async () => {
 const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'position_conflict', message: 'Compare again' } }), { status: 409 }));
 vi.stubGlobal('fetch', fetcher);
 await expect(chooseAccountPosition(session, positionChoice(local))).rejects.toMatchObject({ code: 'position_conflict' });
 expect(fetcher).toHaveBeenCalledTimes(1);
});
it('rejects another account response and compares locators independently of clocks', async () => {
 vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ accountId: 'account-b', positions: [] }))));
 await expect(loadAccountPositions('account-a')).rejects.toMatchObject({ code: 'account_changed' });
 const differentClock = { ...local, updatedAt: 'changed-clock' };
 expect(samePosition(local, differentClock)).toBe(true);
 expect(samePosition(local, { ...local, offset: .9 })).toBe(false);
 expect(positionChoice(local).expectedRevision).toBe(0);
});
