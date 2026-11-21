export interface InstallPrompt extends Event {
 prompt(): Promise<void>;
 userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}
// Call prompt inside the click handler to preserve the browser's user activation.
export function createInstallPrompt(target: EventTarget) {
 let pending: InstallPrompt | null = null;
 let installed = false;
 const listeners = new Set<() => void>();
 const emit = () => listeners.forEach(listener => listener());
 const receive = (event: Event) => { event.preventDefault(); pending = event as InstallPrompt; emit(); };
 const complete = () => { pending = null; installed = true; emit(); };
 target.addEventListener('beforeinstallprompt', receive);
 target.addEventListener('appinstalled', complete);
 return {
  available: () => !!pending,
  installed: () => installed,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  async request() {
   const event = pending;
   if (!event) return 'unavailable' as const;
   pending = null; emit();
   await event.prompt();
   return (await event.userChoice).outcome;
  },
  dispose() { target.removeEventListener('beforeinstallprompt', receive); target.removeEventListener('appinstalled', complete); listeners.clear(); },
 };
}
export const installPrompt = typeof window === 'undefined' ? null : createInstallPrompt(window);
