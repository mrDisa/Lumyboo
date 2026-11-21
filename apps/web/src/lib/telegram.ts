import { applicationEntry } from './hosting';
type Insets = { top?: number; bottom?: number; left?: number; right?: number };
export interface TelegramApp {
 initData: string;
 isVersionAtLeast(version: string): boolean;
 ready(): void;
 expand(): void;
 requestFullscreen?(): void;
 setHeaderColor?(color: string): void;
 setBackgroundColor?(color: string): void;
 safeAreaInset?: Insets;
 contentSafeAreaInset?: Insets;
 onEvent(name: string, callback: () => void): void;
 offEvent(name: string, callback: () => void): void;
}
declare global { interface Window { Telegram?: { WebApp?: TelegramApp } } }

export function connectTelegram(app: TelegramApp, root = document.documentElement) {
 if (!app.initData) return () => {};
 root.dataset.telegram = 'true';
 const safeArea = () => {
  for (const edge of ['top', 'bottom', 'left', 'right'] as const) {
   const inset = Math.max(0, app.safeAreaInset?.[edge] ?? 0) + Math.max(0, app.contentSafeAreaInset?.[edge] ?? 0);
   root.style.setProperty(`--lumyboo-safe-${edge}`, `${inset}px`);
  }
 };
 const colors = () => {
  const color = root.dataset.theme === 'dark' ? '#101010' : '#fafafa';
  app.setHeaderColor?.(color); app.setBackgroundColor?.(color);
 };
 safeArea(); colors(); app.ready(); app.expand();
 if (app.isVersionAtLeast('8.0')) { try { app.requestFullscreen?.(); } catch { /* Older clients still open expanded. */ } }
 app.onEvent('safeAreaChanged', safeArea); app.onEvent('contentSafeAreaChanged', safeArea);
 const observer = new MutationObserver(colors); observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
 return () => { observer.disconnect(); app.offEvent('safeAreaChanged', safeArea); app.offEvent('contentSafeAreaChanged', safeArea); delete root.dataset.telegram; };
}

export async function startTelegram() {
 // The bridge is only loaded for Telegram launches; browser/PWA and iframe demos stay self-contained.
 if (window.self !== window.top || !new URLSearchParams(location.hash.slice(1)).has('tgWebAppPlatform')) return;
 try {
  if (!window.Telegram?.WebApp) await new Promise<void>((resolve, reject) => {
   const script = document.createElement('script'); script.src = 'https://telegram.org/js/telegram-web-app.js?62';
   const timeout = setTimeout(() => reject(new Error('Telegram bridge timed out')), 4000);
   script.onload = () => { clearTimeout(timeout); resolve(); }; script.onerror = () => { clearTimeout(timeout); reject(new Error('Telegram bridge unavailable')); }; document.head.append(script);
  });
  if (window.Telegram?.WebApp?.initData) {
   connectTelegram(window.Telegram.WebApp);
   if (import.meta.env.VITE_STATIC_HOST === 'true') history.replaceState(null, '', location.pathname + location.search + '#' + applicationEntry());
  }
 } catch { /* The reader remains usable if Telegram's bridge cannot load. */ }
}
