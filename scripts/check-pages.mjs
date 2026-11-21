import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const dist = new URL('../apps/web/dist-pages/', import.meta.url);
const publication = JSON.parse(await readFile(new URL('publication.json', dist), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('manifest.webmanifest', dist), 'utf8'));
if (manifest.scope !== '/Lumyboo/' || manifest.id !== '/Lumyboo/' || manifest.start_url !== '/Lumyboo/#/app') throw Error('Invalid Pages installation target');
const names = await readdir(new URL('books/', dist));
const expected = publication.books.map(book => book.url.split('/').at(-1)).sort();
if (JSON.stringify(names.sort()) !== JSON.stringify(expected) || !expected.length) throw Error('Unreviewed or missing public books');
for (const book of publication.books) {
 const raw = await readFile(new URL(book.url.slice(1), dist));
 if (raw.length !== book.bytes || createHash('sha256').update(raw).digest('hex') !== book.sha256) throw Error(`Invalid Pages text: ${book.id}`);
}
const forbiddenBooks = ['room-for-stories', 'white-nights', 'white-nights-excerpt', 'gambler-excerpt'];
if (publication.books.some(book => forbiddenBooks.includes(book.id))) throw Error('Unreviewed content included');
async function inspect(url) {
 for (const name of await readdir(url)) {
  const child = new URL(name, url);
  if ((await stat(child)).isDirectory()) await inspect(new URL(name + '/', url));
  else {
   if (/^(\.env|Lumyboo-Development-Plan|STATUS|QA)/.test(name) || name.endsWith('.map')) throw Error('Private file or source map in Pages payload');
   if (/\.(js|json|html|css)$/.test(name)) {
    const source = await readFile(child, 'utf8');
    if (/\b\d{8,12}:[A-Za-z0-9_-]{30,}/.test(source)) throw Error('Bot token in public artifact');
   }
  }
 }
}
await inspect(dist);
console.log(`Verified Pages payload: ${publication.books.length} reviewed full books, correct scope, no private files or bot tokens.`);
