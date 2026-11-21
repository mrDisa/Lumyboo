import { expect, it } from 'vitest';
import { showcase, telegramLink } from './showcase';
it('offers only full catalog books with print covers in the public demo', () => {
 expect(showcase.length).toBeGreaterThan(0);
 expect(showcase.every(book => book.kind === 'full' && book.cover >= 6 && book.sourceUrl && book.coverSourceUrl)).toBe(true);
 expect(showcase.some(book => book.kind === 'fixture' || book.kind === 'excerpt')).toBe(false);
});
it('accepts actual Telegram entry links and rejects injected or unrelated destinations', () => {
 expect(telegramLink('https://t.me/lumyboo_bot?start=app')).toBe('https://t.me/lumyboo_bot?start=app');
 for(const value of ['javascript:alert(1)','https://t.me.evil.test/lumyboo_bot','https://user@t.me/lumyboo_bot','http://t.me/lumyboo_bot','https://t.me/+invite','']) expect(telegramLink(value)).toBeNull();
});
