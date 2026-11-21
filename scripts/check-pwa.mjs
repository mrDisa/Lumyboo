// Build smoke check: every emitted UI resource must be available to the offline shell.
import { readFile, readdir, access } from 'node:fs/promises';
const dist = new URL(`../apps/web/${process.argv[2] ?? 'dist'}/`, import.meta.url);
const worker = await readFile(new URL('sw.js', dist), 'utf8');
if (/importScripts\s*\(/.test(worker)) throw Error('The worker must be self-contained for cold startup');
const cached = [...worker.matchAll(/\burl:"([^"]+)"/g)].map(match => match[1]);
if (!cached.length || new Set(cached).size !== cached.length) throw Error('Empty or duplicate app precache');
if (cached.some(url => url.startsWith('books/') || url.startsWith('api/'))) throw Error('Books and API must not enter the app precache');
const required = ['index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
for (const file of await readdir(new URL('assets/', dist))) {
 if (/\.(js|css|svg|ttf|png|jpg)$/.test(file)) required.push(`assets/${file}`);
}
for (const file of required) {
 if (!cached.includes(file)) throw Error(`Offline shell is missing ${file}`);
 await access(new URL(file, dist));
}
const index = await readFile(new URL('index.html', dist), 'utf8');
if (/https?:\/\//.test(index)) throw Error('The app shell must not need externally hosted assets');
console.log(`Verified offline shell: ${cached.length} unique resources, self-contained worker, no book/API precache.`);
