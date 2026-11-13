import { useLiveQuery } from 'dexie-react-hooks';
import { accountDatabase } from '../lib/account-reading';
import { accountSaveHeading, accountSaveStatus } from '../lib/account-save-status';

export function AccountSaveStatus({ accountId }: { accountId: string }) {
 const result = useLiveQuery(async () => {
  try { return { status: await accountSaveStatus(accountDatabase(accountId)) }; }
  catch { return { error: true as const }; }
 }, [accountId]);
 return <div className="section" aria-label="Сохранение данных аккаунта">
  <h3>Сохранение данных</h3>
  <p className="description" role="status">{!result ? 'Проверяем сохранение…' : result.error ? 'Не удалось проверить локальное хранилище. Обнови страницу, чтобы повторить проверку.' : accountSaveHeading(result.status)}</p>
  {result?.status && <>
   {!!result.status.total && <p className="description">Только на этом устройстве: места чтения — {result.status.positions}, изменения закладок — {result.status.bookmarks}, записи времени — {result.status.sessions}{result.status.other ? `, другие изменения — ${result.status.other}` : ''}.</p>}
   {!!result.status.choices && <p className="description">Незавершённых сохранений места: {result.status.choices}. {result.status.conflicts ? 'Есть разные варианты места. Открой сохранение ниже и сравни их заново.' : 'Открой сохранение ниже, чтобы проверить и повторить выбранное место.'}</p>}
   <p className="reader-note">Место чтения можно сохранить в аккаунте в разделе ниже. Изменения закладок и времени пока остаются на устройстве. Гостевое чтение учитывается отдельно.</p>
  </>}
 </div>;
}
