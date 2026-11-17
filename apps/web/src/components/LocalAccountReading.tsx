import { DailyGoalCard } from './DailyGoal';
import { Link } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { accountDatabase } from '../lib/account-reading';
import { db } from '../lib/db';
import type { LocalAccount } from '../lib/local-account';
import { books } from '../pages/Library';
import { TransferBook } from './TransferBook';
import { Icon } from './ui';
export function LocalAccountReading({ user, forget }: { user: LocalAccount; forget: () => void }) {
 const store = accountDatabase(user.id);
 const available = useLiveQuery(async () => {
  const [positions, downloads] = await Promise.all([store.positions.toArray(), db.downloads.toArray()]);
  return books.filter(book => positions.some(p => p.bookId === book.id && p.version === book.version) && downloads.some(d => d.bookId === book.id && d.version === book.version));
 }, [store]);
 return <><p className="description account-email">{user.email}</p>
  <div className="local-access-status" role="status"><span className="profile-section-icon"><Icon name="books" /></span><div><strong>Чтение на устройстве</strong><small>Вход не проверен · обмен с аккаунтом недоступен</small></div></div>
  <section className="section" aria-labelledby="local-books-title">
   <div className="section-head"><h3 id="local-books-title">Продолжить чтение</h3>{available !== undefined && <span className="local-books-count" aria-label={`Доступно книг: ${available.length}`}>{available.length}</span>}</div>
   {available === undefined ? <p className="description" role="status">Ищем сохранённые книги…</p> : available.length ? <div className="transfer-list">{available.map(book => <article className="transfer-card" key={book.id}>
    <TransferBook bookId={book.id}><small>Скачана · место на устройстве</small></TransferBook>
    <Link className="secondary section" aria-label={`Продолжить «${book.title}» на устройстве`} to="/account/read/$bookId" params={{ bookId: book.id }}>Продолжить <span aria-hidden="true">→</span></Link>
   </article>)}</div> : <div className="local-books-empty"><Icon name="book" /><strong>Книг для продолжения пока нет</strong><p>Нужны скачанный текст и сохранённое место этого аккаунта.</p></div>}
  </section>
  <DailyGoalCard store={store} />
  <details className="day-details section"><summary>Доступ без подключения</summary><p className="description">Доступны сохранённые на устройстве книги этого аккаунта. Для обмена изменениями подключись к сети.</p><p className="description section">Закрытие локального доступа остановит чтение аккаунта на устройстве до следующего входа. Сохранённые изменения останутся; серверная сессия не будет завершена без подключения.</p></details>
  <button className="text-button section" onClick={forget}>Закрыть локальный доступ к аккаунту</button>
 </>;
}
