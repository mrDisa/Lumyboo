import { registerSW } from 'virtual:pwa-register';

export interface OfflineState {
  supported: boolean;
  shellReady: boolean;
  updateAvailable: boolean;
  error: string | null;
}
let state: OfflineState = {
  supported: typeof navigator !== 'undefined' && 'serviceWorker' in navigator && window.isSecureContext,
  shellReady: false,
  updateAvailable: false,
  error: null,
};
const listeners = new Set<() => void>();
let started = false;
let requestedReload = false;
let reloadRequired = false;
let activateUpdate: ((reloadPage?: boolean) => Promise<void>) | undefined;
function change(patch: Partial<OfflineState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}
export function getOfflineState() { return state; }
export function subscribeOffline(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export async function checkOfflineShell() {
  if (!state.supported) return;
  try {
    const shell = await caches.match('/index.html', { ignoreSearch: true });
    change({ shellReady: !!navigator.serviceWorker.controller && !!shell });
  } catch { change({ shellReady: false, error: 'Не удалось проверить сохранённое приложение. Проверь разрешение на хранение данных.' }); }
}
function reloadIfRequested() {
  // Another tab can activate an update, but it must never interrupt this reader.
  if (requestedReload && !location.pathname.startsWith('/read/')) {
    requestedReload = false;
    location.reload();
  }
}
export function startOfflineShell() {
  if (started || !state.supported) return;
  started = true;
  navigator.serviceWorker.addEventListener('controllerchange', () => { void checkOfflineShell(); });
  activateUpdate = registerSW({
    immediate: true,
    onOfflineReady: () => { void checkOfflineShell(); },
    onRegisteredSW: () => { void checkOfflineShell(); },
    onNeedRefresh: () => { change({ updateAvailable: true }); },
    onNeedReload: () => {
      reloadRequired = true;
      change({ updateAvailable: true });
      reloadIfRequested();
    },
    onRegisterError: () => { change({ shellReady: false, error: 'Не удалось сохранить приложение для запуска без сети. Повтори подготовку при подключении.' }); },
  });
  void checkOfflineShell();
}
export async function retryOfflineShell() {
  if (!state.supported) return;
  change({ error: null });
  if (!started) startOfflineShell();
  const registration = await navigator.serviceWorker.getRegistration();
  if (registration) await registration.update();
  else {
    // A failed first registration may not have created a registration at all.
    started = false;
    startOfflineShell();
  }
  await checkOfflineShell();
}
export async function applyAppUpdate() {
  if (location.pathname.startsWith('/read/')) return;
  requestedReload = true;
  if (reloadRequired) reloadIfRequested();
  else await activateUpdate?.(true);
}
