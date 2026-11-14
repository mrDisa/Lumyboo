// This is permission to reopen this browser's local reading, never a server
// session. Store no cookie or CSRF token, and keep just the last verified user.
const key = 'lumyboo-local-account';
export const authChangeKey = 'lumyboo-auth-changed';
const changed = 'lumyboo-local-account-changed';
export type LocalAccount = { id: string; email: string };
export function localAccountSnapshot(): string | null {
 try { return localStorage.getItem(key); } catch { return null; }
}
export function readLocalAccount(): LocalAccount | null {
 try {
  const value = JSON.parse(localAccountSnapshot() ?? 'null');
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.id) && typeof value.email === 'string' ? { id: value.id, email: value.email } : null;
 } catch { return null; }
}
export function rememberLocalAccount(user: LocalAccount | null) {
 try {
  if (user) localStorage.setItem(key, JSON.stringify({ id: user.id, email: user.email }));
  else localStorage.removeItem(key);
 } catch { /* Without persistent storage, local account access stays disabled. */ }
 if (typeof window !== 'undefined') window.dispatchEvent(new Event(changed));
}
export function authGeneration() {
 try { return localStorage.getItem(authChangeKey); } catch { return null; }
}
export function subscribeLocalAccount(notify: () => void) {
 const storage = (event: StorageEvent) => { if (event.key === key || event.key === authChangeKey || event.key === null) notify(); };
 window.addEventListener('storage', storage);
 window.addEventListener(changed, notify);
 return () => { window.removeEventListener('storage', storage); window.removeEventListener(changed, notify); };
}
export function isConnectionFailure(error: unknown) {
 return error instanceof TypeError || error instanceof DOMException && error.name === 'TimeoutError';
}
