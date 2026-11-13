import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ register: vi.fn() }));
vi.mock('virtual:pwa-register', () => ({ registerSW: mocks.register }));
let callbacks: Record<string, (...args: unknown[]) => void>;
let activate: ReturnType<typeof vi.fn>;
let reload: ReturnType<typeof vi.fn>;
let controller: EventTarget & { controller: object | null; getRegistration: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.resetModules(); callbacks = {}; activate = vi.fn().mockResolvedValue(undefined); reload = vi.fn();
  controller = Object.assign(new EventTarget(), { controller: {}, getRegistration: vi.fn().mockResolvedValue({ update: vi.fn().mockResolvedValue(undefined) }) });
  vi.stubGlobal('navigator', { serviceWorker: controller });
  vi.stubGlobal('window', { isSecureContext: true });
  vi.stubGlobal('location', { pathname: '/catalog', reload });
  vi.stubGlobal('caches', { match: vi.fn().mockResolvedValue(new Response('shell')) });
  mocks.register.mockImplementation((options: typeof callbacks) => { callbacks = options; return activate; });
});
afterEach(() => { vi.unstubAllGlobals(); mocks.register.mockReset(); });
it('registers once even when React mounts effects twice', async () => {
  const pwa = await import('./pwa');
  pwa.startOfflineShell(); pwa.startOfflineShell();
  expect(mocks.register).toHaveBeenCalledTimes(1);
  await pwa.checkOfflineShell(); expect(pwa.getOfflineState().shellReady).toBe(true);
});
it('does not announce offline readiness when the app cache or controller is missing', async () => {
  const pwa = await import('./pwa');
  vi.mocked(caches.match).mockResolvedValueOnce(undefined);
  await pwa.checkOfflineShell(); expect(pwa.getOfflineState().shellReady).toBe(false);
  controller.controller = null;
  await pwa.checkOfflineShell(); expect(pwa.getOfflineState().shellReady).toBe(false);
});
it('keeps a reader open when another tab activates an update', async () => {
  const pwa = await import('./pwa'); pwa.startOfflineShell();
  location.pathname = '/read/test'; callbacks.onNeedRefresh(); callbacks.onNeedReload();
  await pwa.applyAppUpdate();
  expect(reload).not.toHaveBeenCalled(); expect(activate).not.toHaveBeenCalled();
  expect(pwa.getOfflineState().updateAvailable).toBe(true);
  location.pathname = '/catalog'; await pwa.applyAppUpdate(); expect(reload).toHaveBeenCalledTimes(1);
});
it('waits for activation after an explicit update and defers reload if reading starts', async () => {
  const pwa = await import('./pwa'); pwa.startOfflineShell(); callbacks.onNeedRefresh();
  await pwa.applyAppUpdate(); expect(activate).toHaveBeenCalledOnce(); expect(reload).not.toHaveBeenCalled();
  location.pathname = '/read/test'; callbacks.onNeedReload(); expect(reload).not.toHaveBeenCalled();
  location.pathname = '/catalog'; await pwa.applyAppUpdate(); expect(reload).toHaveBeenCalledOnce();
});
it('surfaces registration failure and retries the installation', async () => {
  const pwa = await import('./pwa'); pwa.startOfflineShell(); callbacks.onRegisterError();
  expect(pwa.getOfflineState().error).toContain('Не удалось');
  controller.getRegistration.mockResolvedValueOnce(undefined);
  await pwa.retryOfflineShell(); expect(mocks.register).toHaveBeenCalledTimes(2);
  expect(pwa.getOfflineState().error).toBeNull();
});
