import { useLiveQuery } from 'dexie-react-hooks';
import { accountDatabase } from '../lib/account-reading';
import { accountSaveHeading, accountSaveStatus } from '../lib/account-save-status';

export function AccountSaveStatus({ accountId }: { accountId: string }) {
 const result = useLiveQuery(async () => {
  try { return { status: await accountSaveStatus(accountDatabase(accountId)) }; }
  catch { return { error: true as const }; }
 }, [accountId]);
 return <div className="account-save-card section" aria-label="Сохранение данных аккаунта">
  <h3>Сохранение данных</h3>
  <p className="description" role="status">{!result ? 'Проверяем сохранение…' : result.error ? 'Не удалось проверить локальное хранилище. Обнови страницу, чтобы повторить проверку.' : accountSaveHeading(result.status)}</p>
  {result?.status && <>
   {!!result.status.total && <dl className="save-counts">{[
    ['Места', result.status.positions], ['Закладки', result.status.bookmarks], ['Время', result.status.sessions], ['Фрагменты', result.status.coverage], ['Другие', result.status.other],
   ].filter(([, count]) => !!count).map(([label, count]) => <div key={label}><dt>{label}</dt><dd>{count}</dd></div>)}</dl>}

   {!!result.status.choices && <p className="description">Незавершённых сохранений места: {result.status.choices}. {result.status.conflicts ? 'Есть разные варианты места. Открой «Места и закладки» и сравни их заново.' : 'Открой «Места и закладки», чтобы проверить и повторить выбранное место.'}</p>}
   {!!result.status.bookmarkChoices && <p className="description">Незавершённых сохранений закладок: {result.status.bookmarkChoices}. {result.status.bookmarkConflicts ? 'Есть разные варианты. Открой «Места и закладки» и сравни заново.' : 'Открой «Места и закладки», чтобы повторить выбранное изменение.'}</p>}
   <details className="profile-help"><summary>Где проверить и повторить сохранение</summary><p className="reader-note">При выходе из читалки место и новые изменения закладок сохраняются в аккаунте. При ошибке или конфликте проверь сохранение в разделе «Места и закладки». Прежние изменения закладок можно сравнить и сохранить в разделе «Места и закладки». Время аккаунта сохраняется автоматически; статус и ручное сохранение — в разделе «Время и история». Фрагменты текста можно отправить кнопкой в разделе «Прочитанные фрагменты». Гостевое чтение учитывается отдельно.</p></details>
  </>}
 </div>;
}
