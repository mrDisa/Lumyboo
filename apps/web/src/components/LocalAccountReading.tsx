import { DailyGoalCard } from './DailyGoal';
import { Link } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { accountDatabase } from '../lib/account-reading';
import { db } from '../lib/db';
import type { LocalAccount } from '../lib/local-account';
import { books } from '../pages/Library';
export function LocalAccountReading({ user, forget }: { user: LocalAccount; forget: () => void }) {
 const store = accountDatabase(user.id);
 const available = useLiveQuery(async () => {
  const [positions, downloads] = await Promise.all([store.positions.toArray(), db.downloads.toArray()]);
  return books.filter(book => positions.some(p => p.bookId === book.id && p.version === book.version) && downloads.some(d => d.bookId === book.id && d.version === book.version));
 }, [store]);
 return <><p className="description account-email">{user.email}</p><p className="description" role="status">Без подключения · вход не проверен. Доступны сохранённые на устройстве книги этого аккаунта. Для обмена изменениями подключись к сети.</p>{available === undefined ? <p>Ищем сохранённые книги…</p> : available.length ? available.map(book => <Link key={book.id} className="secondary section" to="/account/read/$bookId" params={{ bookId: book.id }}>Продолжить «{book.title}» на устройстве</Link>) : <p className="description">Нет скачанных книг с сохранённым местом этого аккаунта.</p>}<DailyGoalCard store={store} /><button className="text-button section" onClick={forget}>Закрыть локальный доступ к аккаунту</button><p className="reader-note">Это закроет чтение аккаунта на устройстве до следующего входа. Сохранённые изменения останутся; серверная сессия не будет завершена без подключения.</p></>;
}
