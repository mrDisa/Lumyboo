import { assetUrl } from './hosting';
import catalog from '../data/catalog.json';
import type { Book } from './books';
const ids = ['gambler', 'ward-no-6', 'stationmaster', 'overcoat', 'blizzard', 'what-men-live-by'];
export const showcase = ids.map(id => (catalog as Book[]).find(book => book.id === id)).filter((book): book is Book => !!book && book.kind === 'full');
export const coverUrl = (id: number) => assetUrl(`/assets/cover-${id}.${id >= 6 ? 'jpg' : 'svg'}`);
export function telegramLink(value: string | undefined) {
 if (!value) return null;
 try {
  const url = new URL(value);
  return url.protocol === 'https:' && url.hostname === 't.me' && !url.username && !url.password && /^\/[A-Za-z0-9_]{5,32}(?:\/[A-Za-z0-9_]+)?$/.test(url.pathname) ? url.href : null;
 } catch { return null; }
}
