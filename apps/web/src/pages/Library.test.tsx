import 'fake-indexeddb/auto';
import { beforeEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';

const state = vi.hoisted(() => ({
 account: { session: null, localAccount: null, checking: false, error: null } as Record<string, unknown>,
 snapshot: undefined as unknown,
}));
vi.mock('../lib/auth', () => ({ useAccount: () => state.account }));
vi.mock('dexie-react-hooks', () => ({ useLiveQuery: vi.fn(() => state.snapshot) }));
vi.mock('../lib/context', () => ({ useApp: () => ({ settings: { currentBook: 'room-for-stories' }, act: vi.fn() }) }));
vi.mock('../components/DailyGoal', () => ({ DailyGoalCard: ({ store }: { store: { scope: string } }) => <div data-goal-scope={store.scope} /> }));
vi.mock('@tanstack/react-router', () => ({
 useParams: () => ({ bookId: 'room-for-stories' }),
 Link: ({ to, params, children, ...props }: { to: string; params?: { bookId: string }; children?: ReactNode }) => <a {...props} href={to.replace('$bookId', params?.bookId ?? '')}>{children}</a>,
}));
import { BookDetail, Home, books } from './Library';
const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const position = { version: books.find(book => book.id === 'room-for-stories')!.version, chapter: 3 };
function snapshot(scope: string, bookId = 'room-for-stories') { return { scope, bookId, position }; }
beforeEach(() => { state.account = { session: null, localAccount: null, checking: false, error: null }; state.snapshot = undefined; });
it('keeps guest continuation and guest goal when signed out', () => {
 state.snapshot = snapshot('guest');
 expect(renderToStaticMarkup(<BookDetail />)).toContain('href="/read/room-for-stories"');
 expect(renderToStaticMarkup(<BookDetail />)).toContain('Гостевое место на устройстве');
 expect(renderToStaticMarkup(<Home />)).toContain('data-goal-scope="guest"');
});
it('routes signed-in book and home actions to the account and uses its daily goal', () => {
 state.account.session = { user: { id: owner } }; state.snapshot = snapshot(`account:${owner}`);
 const detail = renderToStaticMarkup(<BookDetail />); const home = renderToStaticMarkup(<Home />);
 for (const markup of [detail, home]) { expect(markup).toContain('href="/account/read/room-for-stories"'); expect(markup).not.toContain('href="/read/room-for-stories"'); }
 expect(detail).toContain('Место аккаунта на устройстве'); expect(detail).not.toContain('Гостевое место');
 expect(home).toContain(`data-goal-scope="account:${owner}"`);
});
it('does not display retained guest, other-account or other-book positions', () => {
 state.account.session = { user: { id: owner } };
 for (const stale of [snapshot('guest'), snapshot(`account:${other}`), snapshot(`account:${owner}`, 'other-book')]) {
  state.snapshot = stale;
  expect(renderToStaticMarkup(<BookDetail />)).not.toContain('book-resume');
  expect(renderToStaticMarkup(<Home />)).not.toContain('сохранённая глава');
 }
});
it('does not offer a guest route or expose a position while checking authentication', () => {
 state.account.checking = true; state.snapshot = snapshot('guest');
 const markup = renderToStaticMarkup(<Home />);
 expect(markup).toContain('Проверяем вход'); expect(markup).not.toContain('/read/room-for-stories'); expect(markup).not.toContain('data-goal-scope');
});
it('asks to check the profile after an unresolved authentication error', () => {
 state.account.error = new Error('Unavailable');
 const markup = renderToStaticMarkup(<BookDetail />);
 expect(markup).toContain('Проверить вход'); expect(markup).not.toContain('/read/room-for-stories');
});
it('opens the separately authorized local account through the account reader gate', () => {
 state.account.error = new TypeError('Failed to fetch'); state.account.localAccount = { id: owner };
 expect(renderToStaticMarkup(<BookDetail />)).toContain('href="/account/read/room-for-stories"');
});
