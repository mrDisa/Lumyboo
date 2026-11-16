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

it('shows tied competition places, saved departures and no time tiebreaker', () => {
 const members = item.members.map((m, i) => ({ ...m, rank: i === 1 ? 3 : 1 }));
 const html = renderToStaticMarkup(<ChallengeProgress item={{ ...item, mode: 'competitive', members }} />);
 expect(html).toContain('Текущие места');
 expect(html.match(/1 место/g)).toHaveLength(2);
 expect(html).toContain('3 место');
 expect(html).toContain('вышел, результат сохранён');
 expect(html).toContain('минуты сверх цели преимущества не дают');
 expect(html.indexOf('Друг')).toBeLessThan(html.indexOf('3 место'));
});
it('explains ended results and late updates without declaring automatic success', () => {
 const html = renderToStaticMarkup(<ChallengeProgress item={{ ...item, mode: 'competitive', progress: { ...item.progress, status: 'ended' } }} />);
 expect(html).toContain('Места по итогам периода');
 expect(html).toContain('Дней без выполненной цели: 6');
 expect(html).toContain('могут изменить результат и места');
 expect(html).not.toContain('Твоя цель выполнена во все дни');
});
it('keeps personal results free of places and hides competition before start', () => {
 const html = renderToStaticMarkup(<ChallengeProgress item={{ ...item, progress: { ...item.progress, status: 'ended' }, members: [{ ...item.members[0], completedDays: 7 }] }} />);
 expect(html).toContain('Твоя цель выполнена во все дни');
 expect(html).toContain('Общего рейтинга в этом формате нет');
 expect(html).not.toContain('место');
 const upcoming = renderToStaticMarkup(<ChallengeProgress item={{ ...item, mode: 'competitive', progress: { ...item.progress, status: 'upcoming' } }} />);
 expect(upcoming).not.toContain('member-place');
 expect(upcoming).not.toContain('challenge-place');
 expect(upcoming).not.toContain('Дней без выполненной цели');
});

it('distinguishes completed, today and future calendar days with accessible labels', () => {
 const html = renderToStaticMarkup(<ChallengeProgress item={{ ...item, progress: { ...item.progress, days: [
  { day: '2026-11-15', milliseconds: 300000, complete: true },
  { day: '2026-11-16', milliseconds: 60000, complete: false },
  { day: '2026-11-17', milliseconds: 0, complete: false },
 ] } }} />);
 expect(html).toContain('class="done" aria-label="15 нояб.: выполнено"');
 expect(html).toContain('class="today" aria-label="16 нояб.: сегодня"');
 expect(html).toContain('class="future" aria-label="17 нояб.: впереди"');
 expect(html).toContain('Сегодня: 1 / 5 мин');
 expect(html).toContain('По сохранённому чтению');
 expect(html).toContain('<details class="challenge-details"><summary>Как считается результат</summary>');
});
