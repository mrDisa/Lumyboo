import type { paths } from './api.generated';
type CatalogResponse = paths['/catalog']['get']['responses'][200]['content']['application/json'];
export async function listBooks(search = '', signal?: AbortSignal): Promise<CatalogResponse> {
 const response = await fetch(`/api/v1/catalog?q=${encodeURIComponent(search)}&limit=50`, { signal, headers: { Accept: 'application/json' } });
 if (!response.ok) throw new Error(`Каталог недоступен (${response.status}). Попробуй ещё раз.`);
 return response.json();
}

export class ApiError extends Error {
 constructor(message: string, public status: number, public code: string, public retryAfter = 0) { super(message); }
}
function retryAfterSeconds(value: string | null) {
 const text = value?.trim() ?? '';
 // asctime HTTP dates omit the zone but still mean GMT, not device time.
 const date = /^[A-Za-z]{3} [A-Za-z]{3} {1,2}\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(text) ? `${text} GMT` : text;
 // Retry-After accepts whole seconds or an HTTP date (including legacy
 // weekday formats). Do not let Date.parse reinterpret invalid numbers.
 const seconds = /^\d+$/.test(text) ? Number(text)
  : /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/.test(text) ? Math.ceil((Date.parse(date) - Date.now()) / 1000) : 0;
 return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}
export async function requestJSON<T>(path: string, init: RequestInit = {}): Promise<T> {
 const headers = new Headers(init.headers);
 headers.set('Accept', 'application/json');
 if (init.body !== undefined) headers.set('Content-Type', 'application/json');
 const controller = new AbortController();
 const timeout = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), 12_000);
 const cancel = () => controller.abort(init.signal?.reason);
 if (init.signal?.aborted) cancel();
 else init.signal?.addEventListener('abort', cancel, { once: true });
 try {
  const response = await fetch(`/api/v1${path}`, { ...init, signal: controller.signal, credentials: 'same-origin', cache: 'no-store', headers });
  if (!response.ok) {
   const body: unknown = await response.json().catch(() => null);
   // A timed-out/cancelled body is still a transport failure. In particular,
   // do not turn it into a definitive sign-out or a terminal sync failure.
   controller.signal.throwIfAborted();
   const error = body && typeof body === 'object' && 'error' in body ? body.error : null;
   const message = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : 'Сервис временно недоступен. Попробуй ещё раз.';
   const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'unavailable';
   throw new ApiError(message, response.status, code, retryAfterSeconds(response.headers.get('Retry-After')));
  }
  if (response.status === 204) return undefined as T;
  return await response.json();
 } finally {
  clearTimeout(timeout);
  init.signal?.removeEventListener('abort', cancel);
 }
}
