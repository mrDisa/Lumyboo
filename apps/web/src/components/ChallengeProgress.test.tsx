import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
vi.mock('../lib/auth', () => ({ useAccount: vi.fn() }));
import { ChallengeProgress } from './Challenges';
import type { Challenge } from '../lib/challenges';

const item: Challenge = {
 id: 'example', name: 'Вместе', mode: 'personal', startDay: '2026-11-16', duration: 7,
 timeZone: 'Europe/Moscow', minutes: 5, nickname: 'Читатель', isOwner: true, left: false,
 members: [
  { nickname: 'Читатель', minutes: 5, left: false, self: true, completedDays: 1, todayComplete: true },
  { nickname: 'Читатель', minutes: 20, left: false, self: false, completedDays: 0, todayComplete: false },
  { nickname: 'Друг', minutes: 10, left: true, self: false, completedDays: 1, todayComplete: true },
 ],
 progress: { today: '2026-11-16', endDay: '2026-11-22', status: 'active', days: [
  { day: '2026-11-16', milliseconds: 300000, complete: true },
  { day: '2026-11-17', milliseconds: 0, complete: false },
 ] },
};
it('shows own fixed target, completed days, future dates and active team progress', () => {
 const html = renderToStaticMarkup(<ChallengeProgress item={item} />);
 expect(html).toContain('Твои выполненные дни: 1 из 7');
 expect(html).toContain('цель выполнили 1 из 2 участников');
 expect(html).toContain('5 / 5 мин · выполнено');
 expect(html).toContain('Впереди');
 expect(html).toContain('по сохранённым датам сессий');
 expect(html).not.toContain('место');
});
it('explains frozen departures and never presents elapsed time as success', () => {
 const html = renderToStaticMarkup(<ChallengeProgress item={{ ...item, left: true, progress: { ...item.progress, status: 'ended' } }} />);
 expect(html).toContain('Период завершён');
 expect(html).toContain('на момент выхода');
 expect(html).not.toContain('цель выполнили');
 expect(html).not.toContain('Поздние записи');
});
