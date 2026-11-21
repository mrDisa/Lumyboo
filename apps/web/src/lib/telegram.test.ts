import { afterEach, expect, it, vi } from 'vitest';
import { connectTelegram, type TelegramApp } from './telegram';
afterEach(() => vi.unstubAllGlobals());
function fixture(version = true, initData = 'telegram-signed-data') {
 const callbacks = new Map<string, () => void>();
 const root = { dataset: { theme: 'dark' } as Record<string, string>, style: { setProperty: vi.fn() } };
 vi.stubGlobal('MutationObserver', class { observe() {} disconnect() {} });
 const app: TelegramApp = { initData, isVersionAtLeast: vi.fn(() => version), ready: vi.fn(), expand: vi.fn(), requestFullscreen: vi.fn(), setHeaderColor: vi.fn(), safeAreaInset: { top: 24, bottom: 20 }, contentSafeAreaInset: { top: 44 }, onEvent: vi.fn((name, fn) => callbacks.set(name, fn)), offEvent: vi.fn() };
 return { app, root, callbacks };
}
it('opens Telegram fullscreen with safe areas and reacts to inset changes', () => {
 const { app, root, callbacks } = fixture(); const dispose = connectTelegram(app, root as unknown as HTMLElement);
 expect(app.ready).toHaveBeenCalledOnce(); expect(app.expand).toHaveBeenCalledOnce(); expect(app.requestFullscreen).toHaveBeenCalledOnce();
 expect(app.setHeaderColor).toHaveBeenCalledWith('#101010'); expect(root.dataset.telegram).toBe('true');
 expect(root.style.setProperty).toHaveBeenCalledWith('--lumyboo-safe-top', '68px');
 app.safeAreaInset = { top: 0 }; callbacks.get('safeAreaChanged')!(); expect(root.style.setProperty).toHaveBeenCalledWith('--lumyboo-safe-top', '44px');
 dispose(); expect(root.dataset.telegram).toBeUndefined(); expect(app.offEvent).toHaveBeenCalledTimes(2);
});
it('keeps old Telegram clients expanded and leaves ordinary browsers unchanged', () => {
 const old = fixture(false); connectTelegram(old.app, old.root as unknown as HTMLElement); expect(old.app.expand).toHaveBeenCalledOnce(); expect(old.app.requestFullscreen).not.toHaveBeenCalled();
 const browser = fixture(true, ''); connectTelegram(browser.app, browser.root as unknown as HTMLElement); expect(browser.app.ready).not.toHaveBeenCalled(); expect(browser.root.dataset.telegram).toBeUndefined();
});
