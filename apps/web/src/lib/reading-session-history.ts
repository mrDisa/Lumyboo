import type { components } from './api.generated';
import { ApiError, requestJSON } from './api';

export type ReadingSessionPage = components['schemas']['AccountReadingSessionPage'];
export async function loadReadingSessionHistory(accountId: string, cursor = '', signal?: AbortSignal): Promise<ReadingSessionPage> {
 const query = new URLSearchParams({ limit: '20' });
 if (cursor) query.set('cursor', cursor);
 const page = await requestJSON<ReadingSessionPage>(`/reading-sessions/?${query}`, { signal });
 if (page.accountId !== accountId) throw new ApiError('Аккаунт изменился. Открой профиль заново.', 409, 'account_changed');
 return page;
}
export function readingDuration(milliseconds: number) {
 const seconds = Math.floor(milliseconds / 1000);
 if (!seconds) return 'меньше секунды';
 const minutes = Math.floor(seconds / 60);
 return minutes ? `${minutes} мин ${seconds % 60} с` : `${seconds} с`;
}
