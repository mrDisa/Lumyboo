import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const books = JSON.parse(await readFile(new URL('../apps/web/src/data/catalog.json', import.meta.url), 'utf8'));
const locations = JSON.parse(await readFile(new URL('../services/api/internal/httpapi/bookmark-locations.json', import.meta.url), 'utf8'));
const expectedLocations = {};
for (const book of books) {
 const raw = await readFile(new URL(`../apps/web/public${book.url}`, import.meta.url));
 if (raw.length !== book.bytes || createHash('sha256').update(raw).digest('hex') !== book.sha256) throw Error(`Invalid manifest: ${book.id}`);
 const content = JSON.parse(raw); const ids=new Set();
 expectedLocations[book.id] = { version: book.version, chapters: content.chapters.map(c => c.paragraphs.map(p => p.id)) };
 if(content.id!==book.id||content.version!==book.version) throw Error(`Version mismatch: ${book.id}`);
 for(const chapter of content.chapters) for(const p of chapter.paragraphs){ if(ids.has(p.id)||!p.text.trim()) throw Error('Duplicate locator or empty paragraph'); ids.add(p.id); }
}
if(JSON.stringify(locations)!==JSON.stringify(expectedLocations)) throw Error('Bookmark locations differ from book content');
const apiSeed = JSON.parse(await readFile(new URL('../services/api/internal/httpapi/catalog.json', import.meta.url),'utf8'));
if(JSON.stringify(apiSeed)!==JSON.stringify(books))throw Error('API seed differs from web catalog');
console.log(`Verified ${books.length} book manifests and API seed.`);
