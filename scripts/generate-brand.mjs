import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
// Keep the approved sculptural mark as the single source for every export.
const publicDir = new URL('../apps/web/public/', import.meta.url);
const source = readFileSync(new URL('assets/sculpture.svg', publicDir), 'utf8');
const body = `<g transform="rotate(-25 120 120)">${source.slice(source.indexOf('>') + 1, source.lastIndexOf('</svg>'))}</g>`;
writeFileSync(new URL('assets/brand-mark.svg', publicDir), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240">${body}</svg>`);
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#101010"/><g transform="translate(76 76) scale(1.5)" style="filter:invert(1)">${body}</g></svg>`;
// Inversion is baked into SVG colors, so all rasterizers render it identically.
const inverted = icon.replace(/#[0-9a-f]{6}/gi, (hex, offset) => offset < icon.indexOf('<g ') ? hex : '#' + [1, 3, 5].map(i => (255 - parseInt(hex.slice(i, i + 2), 16)).toString(16).padStart(2, '0')).join('')).replace(' style="filter:invert(1)"', '');
writeFileSync(new URL('assets/logo.svg', publicDir), inverted);
for (const size of [180, 192, 512]) writeFileSync(new URL(`icon-${size}.png`, publicDir), new Resvg(inverted, { fitTo: { mode: 'width', value: size } }).render().asPng());
const exports = new URL('../brand/', import.meta.url);
mkdirSync(exports, { recursive: true });
writeFileSync(new URL('lumyboo-telegram-avatar.png', exports), new Resvg(inverted, { fitTo: { mode: 'width', value: 1024 } }).render().asPng());
console.log('Generated favicon, PWA icons and 1024px Telegram avatar from sculpture.svg.');
