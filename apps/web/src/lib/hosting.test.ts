import { expect, it } from 'vitest';
import { applicationEntry, appHref, assetUrl, readingLocation } from './hosting';
it('keeps all public assets inside the configured Pages subdirectory', () => {
 expect(assetUrl('/books/gambler.json', '/Lumyboo/')).toBe('/Lumyboo/books/gambler.json');
 expect(assetUrl('/assets/cover-10.jpg', '/Lumyboo/')).toBe('/Lumyboo/assets/cover-10.jpg');
 expect(assetUrl('/books/gambler.json', '/')).toBe('/books/gambler.json');
});
it('generates reloadable Pages routes without changing normal server links', () => {
 expect(appHref('/demo?book=gambler', true, '/Lumyboo/')).toBe('/Lumyboo/#/demo?book=gambler');
 expect(appHref('/app', false, '/')).toBe('/app');
});
it('protects readers from updates in both hash and server routes', () => {
 expect(readingLocation({ pathname: '/Lumyboo/', hash: '#/read/gambler' })).toBe(true);
 expect(readingLocation({ pathname: '/Lumyboo/', hash: '#/account/read/gambler?chapter=1' })).toBe(true);
 expect(readingLocation({ pathname: '/read/gambler' })).toBe(true);
 expect(readingLocation({ pathname: '/Lumyboo/', hash: '#/app' })).toBe(false);
});

it('allows only known bot destinations', () => {
 expect(applicationEntry('?app=1&view=profile')).toBe('/profile');
 expect(applicationEntry('?app=1&view=catalog')).toBe('/catalog');
 expect(applicationEntry('?app=1&view=https://example.test')).toBe('/app');
});
