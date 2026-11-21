export const staticHost = import.meta.env.VITE_STATIC_HOST === 'true';
export function assetUrl(path: string, base = import.meta.env.BASE_URL) {
 return `${base.replace(/\/$/, '')}/${path.replace(/^\/+/, '')}`;
}
export function appHref(path: string, preview = staticHost, base = import.meta.env.BASE_URL) {
 return preview ? `${base}#${path}` : path;
}
export function routeSearch() {
 return new URLSearchParams(staticHost ? location.hash.split('?')[1]?.split('#')[0] ?? '' : location.search);
}
export function readingLocation(value: { pathname: string; hash?: string }) {
 const path = value.hash?.startsWith('#/') ? value.hash.slice(1).split(/[?#]/)[0] : value.pathname;
 return path.startsWith('/read/') || path.startsWith('/account/read/');
}
