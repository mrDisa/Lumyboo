import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db, setSettings, toggleShelf, toggleBookmark, type Position } from './db';
afterEach(async () => { await db.delete(); await db.open(); });
describe('durable local data', () => {
 it('keeps paragraph locators and bookmarks across reopen', async () => { const p:Position={ bookId:'test',version:'1',chapter:2,paragraph:'ch-3-p-4',offset:.43,updatedAt:'2026-11-13T00:00:00Z' };await db.positions.put(p);await toggleBookmark(p,'Chapter 3');db.close();await db.open();expect(await db.positions.get('test')).toEqual(p);expect(await db.bookmarks.count()).toBe(1);await toggleBookmark(p,'Chapter 3');expect(await db.bookmarks.count()).toBe(0); });
 it('preserves independent settings in concurrent transactions', async () => { await Promise.all([setSettings({theme:'dark'}),setSettings({fontSize:24})]);expect(await db.settings.get('local')).toMatchObject({theme:'dark',fontSize:24}); });
 it('does not sum repeated session snapshots', async () => { const base={id:'same-session',day:'2026-11-13',bookId:'test'};await db.sessions.put({...base,seconds:30});await db.sessions.put({...base,seconds:60});expect((await db.sessions.toArray()).reduce((n,s)=>n+s.seconds,0)).toBe(60); });
});
it('preserves the earlier edition locator before saving a new edition', async () => {
 const { loadPosition } = await import('./db');
 const old:Position={bookId:'edition-test',version:'1',chapter:2,paragraph:'old-p',offset:.5,updatedAt:'2026-11-13T00:00:00Z'};
 await db.positions.put(old);
 expect(await loadPosition('edition-test','2')).toEqual(old);
 await db.positions.put({...old,version:'2',chapter:0,paragraph:'new-p',offset:0});
 expect(await db.positionHistory.get('edition-test:1')).toMatchObject(old);
 expect(await db.positions.get('edition-test')).toMatchObject({version:'2',paragraph:'new-p'});
});
it('upgrades a v1 local database without losing positions or bookmarks', async () => {
 const { default: Dexie } = await import('dexie'); const { LocalDatabase } = await import('./db');
 const name='lumyboo-schema-upgrade-test';const oldDb=new Dexie(name);
 oldDb.version(1).stores({settings:'id',positions:'bookId',bookmarks:'id, bookId',shelf:'bookId',downloads:'bookId',sessions:'id, day, bookId'});
 const p:Position={bookId:'v1-book',version:'1',chapter:1,paragraph:'v1-p',offset:.6,updatedAt:'2026-11-13T00:00:00Z'};
 try {
  await oldDb.table('positions').put(p); await oldDb.table('bookmarks').put({...p,id:'v1-book:1:v1-p',label:'Old bookmark'}); oldDb.close();
  const upgraded=new LocalDatabase(name);
  try { await upgraded.open();expect(await upgraded.positions.get(p.bookId)).toEqual(p);expect(await upgraded.bookmarks.count()).toBe(1);expect(await upgraded.positionHistory.count()).toBe(0); }
  finally { await upgraded.delete(); }
 } finally { oldDb.close(); await Dexie.delete(name); }
});

it('saves settings and shelf on LAN HTTP without randomUUID', async () => {
 const getRandomValues = crypto.getRandomValues.bind(crypto);
 vi.stubGlobal('crypto', { getRandomValues });
 try {
  await setSettings({ theme: 'dark' });
  await toggleShelf('test');
  db.close(); await db.open();
  expect(await db.settings.get('local')).toMatchObject({ theme: 'dark' });
  expect(await db.shelf.get('test')).toBeDefined();
  const operations = await db.outbox.toArray();
  expect(operations).toHaveLength(2);
  expect(new Set(operations.map(row => row.id)).size).toBe(2);
  expect(operations.every(row => /^[0-9a-f-]{36}$/.test(row.id))).toBe(true);
 } finally { vi.unstubAllGlobals(); }
});
