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
   {!!result.status.total && <p className="description">Ожидают подтверждения: места чтения — {result.status.positions}, изменения закладок — {result.status.bookmarks}, записи времени — {result.status.sessions}, фрагменты текста — {result.status.coverage}{result.status.other ? `, другие изменения — ${result.status.other}` : ''}.</p>}
   {!!result.status.choices && <p className="description">Незавершённых сохранений места: {result.status.choices}. {result.status.conflicts ? 'Есть разные варианты места. Открой сохранение ниже и сравни их заново.' : 'Открой сохранение ниже, чтобы проверить и повторить выбранное место.'}</p>}
   {!!result.status.bookmarkChoices && <p className="description">Незавершённых сохранений закладок: {result.status.bookmarkChoices}. {result.status.bookmarkConflicts ? 'Есть разные варианты. Открой сохранение закладки ниже и сравни заново.' : 'Открой сохранение закладки ниже, чтобы повторить выбранное изменение.'}</p>}
   <p className="reader-note">Место чтения можно сохранить в аккаунте в разделе ниже. Закладки можно сравнить и сохранить отдельно ниже. Время аккаунта сохраняется автоматически; статус и ручное сохранение — в разделе «Время чтения аккаунта». Фрагменты текста можно отправить кнопкой в разделе ниже. Гостевое чтение учитывается отдельно.</p>
  </>}
 </div>;
}
