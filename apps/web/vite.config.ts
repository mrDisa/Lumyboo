import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
export default defineConfig({
  plugins: [react(), VitePWA({
    registerType: 'prompt', includeManifestIcons: false,
    manifest: { name: 'Lumyboo — время для историй', short_name: 'Lumyboo', lang: 'ru', description: 'Книги, которые остаются с тобой', theme_color: '#fafafa', background_color: '#fafafa', display: 'standalone', start_url: '/', icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }] },
    workbox: { clientsClaim: true, skipWaiting: false, inlineWorkboxRuntime: true, dontCacheBustURLsMatching: /assets\/.*-[a-zA-Z0-9_-]{8,}\.(js|css)$/, globPatterns: ['**/*.{js,css,html,ttf,svg,png,jpg}'], navigateFallbackDenylist: [/^\/api\//, /^\/books\//], cleanupOutdatedCaches: true },
  })], server: { proxy: { '/api': 'http://127.0.0.1:8080' } },
});
