import { assetUrl, readingLocation } from './hosting';
import { registerSW } from 'virtual:pwa-register';
import { withUpdateProtection } from './update-guard';

export interface OfflineState {
  supported: boolean;
  shellReady: boolean;
  updateAvailable: boolean;
  updating: boolean;
  error: string | null;
}
let state: OfflineState = {
  supported: typeof navigator !== 'undefined' && 'serviceWorker' in navigator && window.isSecureContext,
  shellReady: false,
  updateAvailable: false,
  updating: false,
  error: null,
};
const listeners = new Set<() => void>();
let started = false;
let requestedReload = false;
let updatePromise: Promise<void> | undefined;
let activationFinished: (() => void) | undefined;
let activationFailed: ((error: Error) => void) | undefined;
let watchingController = false;
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
    const shell = await caches.match(assetUrl('/index.html'), { ignoreSearch: true });
    change({ shellReady: !!navigator.serviceWorker.controller && !!shell });
  } catch { change({ shellReady: false, error: 'Не удалось проверить сохранённое приложение. Проверь разрешение на хранение данных.' }); }
}
function reloadIfRequested() {
  // Another tab can activate an update, but it must never interrupt this reader.
  if (requestedReload && !readingLocation(location)) {
    requestedReload = false;
    location.reload();
  }
}
function activatedUpdate() {
  reloadRequired = true;
  change({ updateAvailable: true });
  activationFinished?.();
}
export function startOfflineShell() {
  if (started || !state.supported) return;
  started = true;
  if (!watchingController) {
    watchingController = true;
    let previous = navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      const current = navigator.serviceWorker.controller;
      if (previous && current && current !== previous) activatedUpdate();
      previous = current;
      void checkOfflineShell();
    });
  }
  activateUpdate = registerSW({
    immediate: true,
    onOfflineReady: () => { void checkOfflineShell(); },
    onRegisteredSW: () => { void checkOfflineShell(); },
    onNeedRefresh: () => { change({ updateAvailable: true }); },
    onNeedReload: activatedUpdate,
    onRegisterError: () => {
      const error = new Error('Не удалось сохранить приложение для запуска без сети. Повтори подготовку при подключении.');
      change({ shellReady: false, error: error.message });
      activationFailed?.(error);
    },
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
  if (readingLocation(location)) return;
  if (updatePromise) return updatePromise;
  change({ updating: true });
  updatePromise = withUpdateProtection(async () => {
    requestedReload = true;
    try {
      if (!reloadRequired) {
        if (!activateUpdate) throw new Error('Обновление ещё не готово. Повтори попытку.');
        const activated = new Promise<void>((resolve, reject) => { activationFinished = resolve; activationFailed = reject; });
        await Promise.all([activateUpdate(true), activated]);
      }
      reloadIfRequested();
    } finally {
      requestedReload = false;
      activationFinished = undefined;
      activationFailed = undefined;
    }
  }).finally(() => {
    updatePromise = undefined;
    change({ updating: false });
  });
  return updatePromise;
}
