import type { paths } from './api.generated';
type CatalogResponse = paths['/catalog']['get']['responses'][200]['content']['application/json'];
export async function listBooks(search = '', signal?: AbortSignal): Promise<CatalogResponse> {
 const response = await fetch(`/api/v1/catalog?q=${encodeURIComponent(search)}&limit=50`, { signal, headers: { Accept: 'application/json' } });
 if (!response.ok) throw new Error(`Каталог недоступен (${response.status}). Попробуй ещё раз.`);
 return response.json();
}
