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
   const error = body && typeof body === 'object' && 'error' in body ? body.error : null;
   const message = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : 'Сервис временно недоступен. Попробуй ещё раз.';
   const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'unavailable';
   const retry = Number(response.headers.get('Retry-After'));
   throw new ApiError(message, response.status, code, Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : 0);
  }
  if (response.status === 204) return undefined as T;
  return await response.json();
 } finally {
  clearTimeout(timeout);
  init.signal?.removeEventListener('abort', cancel);
 }
}
