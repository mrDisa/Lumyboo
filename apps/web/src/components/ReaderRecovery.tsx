import type { ReactNode } from 'react';
import { Icon } from './ui';
import styles from '../pages/Reader.module.css';

export function ReaderNotice({ icon, title, children, detail, alert = false }: { icon: string; title: string; children: ReactNode; detail?: string; alert?: boolean }) {
  return <section className={styles.recovery}>
    <div className={styles.recoveryHeading} role={alert ? 'alert' : 'status'}><span><Icon name={icon} /></span><h2>{title}</h2></div>
    <div className={styles.recoveryBody}>{children}</div>
    {detail && <details className={styles.coverageHelp}><summary>Подробности</summary><p>{detail}</p></details>}
  </section>;
}

export function ReaderSaveError({ localSaved, error, retry, leave }: { localSaved: boolean; error: string; retry: () => void; leave: () => void }) {
  return <ReaderNotice icon={localSaved ? 'check' : 'bookmark'} title={localSaved ? 'На устройстве сохранено' : 'Чтение не сохранено'} detail={error} alert>
    <ul className={styles.saveLocations} aria-label="Состояние сохранения">
      <li><Icon name={localSaved ? 'check' : 'close'} /><span>На устройстве<small>{localSaved ? 'Место и закладки сохранены' : 'Сохранение не удалось'}</small></span></li>
      {localSaved && <li><Icon name="profile" /><span>В аккаунте<small>Все изменения ещё не подтверждены</small></span></li>}
    </ul>
    <p>{localSaved ? 'Повтори сохранение, чтобы продолжить на другом устройстве.' : 'Останься в читалке, проверь свободное место и повтори сохранение.'}</p>
    <button className="primary" onClick={retry}>Повторить сохранение<Icon name="arrow" /></button>
    {localSaved && <button className="secondary" onClick={leave}>Выйти с местом на устройстве</button>}
  </ReaderNotice>;
}

export function ReaderPlaces({ local, remote, localValid, remoteValid, savedChoice, conflict, busy, start }: { local: string; remote: string; localValid: boolean; remoteValid: boolean; savedChoice: boolean; conflict: boolean; busy: boolean; start: (remote: boolean) => void }) {
  return <section className={styles.positionRecovery} aria-label="Выбор места чтения">
    <p className="description">Откуда продолжить?</p>
    <div className={styles.positionOptions}>
      <div><Icon name="monitor" /><h2>На устройстве</h2><p>{local}</p><button className="secondary" disabled={busy} onClick={() => start(false)}>{localValid ? 'Читать отсюда' : 'Начать с начала'}<Icon name="arrow" /></button></div>
      <div><Icon name="profile" /><h2>В аккаунте</h2><p>{remote}</p>{remoteValid && !savedChoice ? <button className="primary" disabled={busy} onClick={() => start(true)}>Читать отсюда<Icon name="arrow" /></button> : <small>{savedChoice ? 'Сначала проверь сохранение в профиле' : 'Место не подходит к этому изданию'}</small>}</div>
    </div>
    {savedChoice && <div className={styles.recoveryHint} role="status"><Icon name="bookmark" /><span>{conflict ? 'Места требуют сравнения' : 'Есть незавершённое сохранение'}<small>Открой профиль для проверки. Можно читать на устройстве; сохранённый выбор останется доступен.</small></span></div>}
    <details className={styles.coverageHelp}><summary>Что будет с другим местом?</summary><p>Другой вариант останется в истории или аккаунте. Гостевые данные сохранятся отдельно.</p></details>
  </section>;
}
