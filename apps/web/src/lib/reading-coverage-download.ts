import { getSession, type AccountSession } from './auth';
import { requestJSON } from './api';
import type { BookContent } from './books';
import type { LocalDatabase } from './db';
import { mergeTextRanges, type TextRange } from './reading-coverage';
import { validCoverageRanges, type CoverageReport } from './reading-coverage-sync';
import { ReadingAutoBusyError } from './reading-auto';

// Match PostgreSQL C collation for paragraph IDs, including non-ASCII IDs.
function compareIDs(a: string, b: string) {
 const encoder = new TextEncoder(); const left = encoder.encode(a); const right = encoder.encode(b);
 for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i] - right[i];
 return left.length - right.length;
}

// Explicit additive import for one verified edition. Fetch and validate every
// live page before a single local commit. An empty history never deletes data.
export async function receiveReadingCoverage(store: LocalDatabase, session: AccountSession, content: BookContent, signal?: AbortSignal) {
 if (store.scope !== `account:${session.user.id}`) throw new Error('Аккаунт изменился. Открой профиль заново.');
 if (!navigator.locks) throw new Error('Для безопасного сохранения открой приложение в обновлённом браузере по HTTPS или на localhost.');
 signal?.throwIfAborted();
 return navigator.locks.request(`lumyboo-reading-coverage:${store.scope}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
  if (!lock) throw new ReadingAutoBusyError('Фрагменты сохраняются в другой вкладке. Дождись завершения и повтори действие.');
  async function checkOwner() {
   signal?.throwIfAborted();
   const live = await getSession(signal);
   if (!live || live.user.id !== session.user.id) throw new Error('Аккаунт изменился. Открой профиль заново.');
   signal?.throwIfAborted();
  }
  await checkOwner();
  const paragraphs = new Map(content.chapters.flatMap(chapter => chapter.paragraphs.map(p => [p.id, chapter.id] as const)));
  const observed = new Set<string>(); const received: CoverageReport[] = [];
  let cursor = '';
  for (;;) {
   signal?.throwIfAborted();
   const query = new URLSearchParams({ version: content.version, limit: '50' });
   if (cursor) query.set('cursor', cursor);
   const page = await requestJSON<{ accountId: string; items: CoverageReport[]; nextCursor: string }>(`/reading-coverage/${encodeURIComponent(content.id)}?${query}`, { signal });
   if (page?.accountId !== session.user.id) throw new Error('Аккаунт изменился. Открой профиль заново.');
   if (!Array.isArray(page.items) || page.items.length > 50 || typeof page.nextCursor !== 'string') throw new Error('Не удалось проверить фрагменты аккаунта. Повтори получение.');
   let previous = cursor;
   for (const p of page.items) {
    if (!p || p.bookId !== content.id || p.version !== content.version || !paragraphs.has(p.paragraph) || observed.has(p.paragraph) || compareIDs(p.paragraph, previous) <= 0 || !validCoverageRanges(p.ranges, 256)) throw new Error('Фрагменты аккаунта не соответствуют этому изданию. Повтори получение.');
    observed.add(p.paragraph); received.push(p); previous = p.paragraph;
   }
   if (!page.nextCursor) break;
   if (page.items.length !== 50 || page.nextCursor !== previous || compareIDs(page.nextCursor, cursor) <= 0) throw new Error('Не удалось проверить продолжение фрагментов. Повтори получение.');
   cursor = page.nextCursor;
  }
  // The cookie may have changed while pages were loading. Always recheck before
  // committing to the captured owner database, even when the page was empty.
  await checkOwner();
  return store.transaction('rw', store.coverage, async () => {
   let changed = 0;
   for (const p of received) {
    signal?.throwIfAborted();
    const key: [string, string, string] = [content.id, content.version, p.paragraph];
    const local = await store.coverage.get(key); const chapter = paragraphs.get(p.paragraph)!;
    if (local && local.chapter !== chapter) throw new Error('Структура издания изменилась. Открой книгу заново.');
    const incoming = p.ranges.map(([from, to]): TextRange => [from / 1_000_000, to / 1_000_000]);
    const ranges = mergeTextRanges([...(local?.ranges ?? []), ...incoming]);
    if (JSON.stringify(ranges) === JSON.stringify(local?.ranges)) continue;
    // Preserve the legacy local queue marker. Existing pending/sending requests
    // and unqueued local observations remain eligible for their own save.
    await store.coverage.put({ bookId: content.id, version: content.version, chapter, paragraph: p.paragraph, ranges, ...(local && !local.queued ? {} : { queued: true as const }) });
    changed++;
   }
   signal?.throwIfAborted();
   return changed;
  });
 });
}
