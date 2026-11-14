import { useEffect } from 'react';
import type { AccountSession } from '../lib/auth';
import type { BookContent } from '../lib/books';
import type { LocalDatabase } from '../lib/db';
import { useApp } from '../lib/context';
import { startReadingCoverageReceive } from '../lib/reading-coverage-receive-auto';

export function ReceiveReaderCoverage({ store, content, session }: { store: LocalDatabase; content: BookContent; session?: AccountSession }) {
 // The reader gate owns the live session check. Mounting another auth query
 // here would refresh it and unmount the gate while it holds the reading lock.
 const { notify } = useApp();
 const accountId = session?.user.id;
 useEffect(() => {
  if (!session || store.scope !== `account:${accountId}`) return;
  const receiver = startReadingCoverageReceive({ store, session, content,
   online: () => navigator.onLine,
   foreground: () => document.visibilityState === 'visible' && document.hasFocus(),
   publish: state => { if (state.phase === 'paused') notify(`${state.message} Чтение на устройстве доступно; повтори получение в профиле.`); },
  });
  const wake = () => receiver.reconnect();
  const refresh = () => { if (document.visibilityState === 'visible' && document.hasFocus()) receiver.refresh(); };
  window.addEventListener('online', wake);
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', refresh);
  return () => {
   receiver.stop(); window.removeEventListener('online', wake);
   window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh);
  };
 }, [store, content, accountId]);
 return null;
}
