import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
export default defineConfig(({ mode }) => {
 const preview = mode === 'pages';
 const base = preview ? '/Lumyboo/' : '/';
 const root = fileURLToPath(new URL('../../', import.meta.url));
 const original = path.join(root, 'apps/web/public');
 const staging = path.join(root, '.content-staging/pages-public');
 const catalog = JSON.parse(readFileSync(path.join(root, 'apps/web/src/data/catalog.json'), 'utf8'));
 const batch = JSON.parse(readFileSync(path.join(root, 'content/batches/classics-01.json'), 'utf8'));
 const approved = new Set(['what-men-live-by', 'ward-no-6', ...batch.books.filter((book: any) => book.review.textApproved && book.review.rightsApproved && book.cover?.approved).map((book: any) => book.id)]);
 const published = catalog.filter((book: any) => book.kind === 'full' && approved.has(book.id));
 if (preview) {
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(path.join(staging, 'books'), { recursive: true });
  mkdirSync(path.join(staging, 'assets'), { recursive: true });
  for (const name of ['icon-180.png', 'icon-192.png', 'icon-512.png', 'licenses']) cpSync(path.join(original, name), path.join(staging, name), { recursive: true });
  const covers = new Set(published.map((book: any) => `cover-${book.cover}.jpg`));
  for (const name of readdirSync(path.join(original, 'assets'))) {
   if (/^font-\d+\.ttf$/.test(name) || ['sculpture.svg', 'brand-mark.svg', 'logo.svg'].includes(name) || covers.has(name)) cpSync(path.join(original, 'assets', name), path.join(staging, 'assets', name));
  }
  for (const book of published) cpSync(path.join(original, book.url.slice(1)), path.join(staging, book.url.slice(1)));
  writeFileSync(path.join(staging, 'publication.json'), JSON.stringify({ type: 'guest-reading-preview', base, books: published.map(({ id, title, author, version, sha256, bytes, url, sourceUrl, coverSourceUrl }: any) => ({ id, title, author, version, sha256, bytes, url, sourceUrl, coverSourceUrl })) }, null, 2) + '\n');
 }
 return {
  base,
  publicDir: preview ? staging : original,
  build: { outDir: preview ? 'dist-pages' : 'dist' },
  define: preview ? { 'import.meta.env.VITE_STATIC_HOST': JSON.stringify('true') } : {},
  plugins: [react(), {
   name: 'reviewed-pages-catalog', enforce: 'pre',
   transform(_source, id) { if (preview && id.endsWith('/src/data/catalog.json')) return JSON.stringify(published); },
  }, VitePWA({
   registerType: 'prompt', includeManifestIcons: false,
   manifest: { id: base, scope: base, name: 'Lumyboo — время для историй', short_name: 'Lumyboo', lang: 'ru', description: 'Книги, которые остаются с тобой', theme_color: '#fafafa', background_color: '#fafafa', display: 'standalone', start_url: preview ? `${base}#/app` : '/app', icons: [{ src: `${base}icon-192.png`, sizes: '192x192', type: 'image/png' }, { src: `${base}icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any maskable' }] },
   workbox: { clientsClaim: true, skipWaiting: false, inlineWorkboxRuntime: true, dontCacheBustURLsMatching: /assets\/.*-[a-zA-Z0-9_-]{8,}\.(js|css)$/, globPatterns: ['**/*.{js,css,html,ttf,svg,png,jpg}'], navigateFallback: `${base}index.html`, navigateFallbackDenylist: [new RegExp(`^${base}(api|books)/`)], cleanupOutdatedCaches: true },
  })],
  server: { proxy: { '/api': 'http://127.0.0.1:8080' } },
 };
});
