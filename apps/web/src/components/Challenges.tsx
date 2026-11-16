import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAccount } from '../lib/auth';
import { useApp } from '../lib/context';
import { challengeAction, createChallenge, listChallenges, pendingChallenge, type Challenge, type Conditions } from '../lib/challenges';
import { goalDay, nextGoalDay } from '../lib/daily-goal';
const modes = { competitive: 'Соревновательный', personal: 'Личностный' } as const;
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Не удалось сохранить. Попробуй ещё раз.';
function ConditionsCard({ item, children }: { item: Challenge; children?: React.ReactNode }) {
 return <article className="expedition challenge-card"><span className="tag">{modes[item.mode]}</span><h2 className="section">{item.name}</h2><dl className="reading-days"><div><dt>Старт</dt><dd>{new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${item.startDay}T12:00:00Z`))}</dd></div><div><dt>Длительность</dt><dd>{item.duration} дней</dd></div><div><dt>{item.mode === 'competitive' ? 'Цель для всех' : 'Твоя цель'}</dt><dd>{item.minutes} мин в день</dd></div><div><dt>Часовой пояс</dt><dd>{item.timeZone}</dd></div><div><dt>Твой псевдоним</dt><dd>{item.nickname}</dd></div></dl><p className="reader-note section">Цель сохраняется на весь челлендж.</p>{children}</article>;
}
function DatePolicy() {
 return <p className="reader-note section">Чтение учитывается по сохранённым датам сессий. При разных часовых поясах дата чтения может отличаться от даты команды; минуты между днями не переносятся.</p>;
}
export function ChallengeProgress({ item }: { item: Challenge }) {
 const p = item.progress; const self = item.members.find(m => m.self);
 const active = item.members.filter(m => !m.left);
 return <section className="section" aria-label="Прогресс челленджа">
 <h3>{p.status === 'upcoming' ? 'Старт впереди' : p.status === 'ended' ? 'Период завершён' : 'Читаем вместе'}</h3>
 <p className="description">Твои выполненные дни: {self?.completedDays ?? 0} из {item.duration}. Последний день — {p.endDay}.</p>
 {p.status === 'active' && <p className="reader-note">Сегодня, {p.today}: цель выполнили {active.filter(m => m.todayComplete).length} из {active.length} участников.</p>}
 <p className="reader-note">{item.left ? 'После выхода результат сохранён на момент выхода.' : 'Показано время, сохранённое в аккаунте. Чтение без сети появится после отправки. Поздние записи могут дополнить прошедшие дни.'}</p>
 <DatePolicy />
 <details className="section"><summary>Твои дни и время</summary><dl className="reading-days">{p.days.map(day => <div key={day.day}><dt>{day.day}{day.day === p.today ? ' · сегодня' : ''}</dt><dd>{day.day > p.today ? 'Впереди' : `${Math.floor(day.milliseconds / 60000)} / ${item.minutes} мин · ${day.complete ? 'выполнено' : 'не выполнено'}`}</dd></div>)}</dl></details>
 </section>;
}
function MembershipCard({ item, owner, refresh }: { item: Challenge; owner: string; refresh: () => Promise<unknown> }) {
 const [code, setCode] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false); const [leaving, setLeaving] = useState(false);
 const beforeStart = item.progress.status === 'upcoming';
 async function act(kind: 'invite' | 'revoke' | 'leave') {
  setBusy(true); setMessage('');
  try {
   const result = await challengeAction(owner, { kind, challengeId: item.id });
   setCode(result.code); setLeaving(false);
   setMessage(kind === 'revoke' ? 'Прежний код больше не работает. Вступившие участники остаются в команде.' : kind === 'leave' ? '' : 'Отправь код другу лично. В приложении ему нужно открыть челленджи и выбрать «Вступить по коду».');
   await refresh();
  } catch (error) { setMessage(errorText(error)); } finally { setBusy(false); }
 }
 return <ConditionsCard item={item}>
 <ChallengeProgress item={item} />
 <h3 className="section">Команда · {item.members.filter(m => !m.left).length}/10</h3>
 <ul className="description">{item.members.map((m, index) => <li key={index}>{m.nickname}{m.self ? ' · ты' : ''} · {m.minutes} мин · {m.completedDays}/{item.duration} дней{m.left ? ' · вышел' : item.progress.status === 'active' && m.todayComplete ? ' · сегодня выполнено' : ''}</li>)}</ul>
 {item.left ? <p className="reader-note">Ты вышел из этого челленджа. Запись участия сохранена.</p> : <>
 {item.isOwner && <><p className="reader-note">Код открывает вступление до старта. Делись им только с теми, кого хочешь пригласить.</p>{beforeStart && <button className="secondary section" disabled={busy} onClick={() => void act('invite')}>Показать код приглашения</button>}<button className="text-button section" disabled={busy} onClick={() => void act('revoke')}>Отозвать приглашение</button></>}
 {code && <div className="section"><label className="field-label" htmlFor={`invite-${item.id}`}>Код для друга</label><input id={`invite-${item.id}`} aria-label="Код для друга" readOnly value={code} onFocus={e => e.target.select()} /><button className="secondary section" disabled={busy} onClick={() => { void navigator.clipboard.writeText(code).then(() => setMessage('Код скопирован.'), () => setMessage('Выдели и скопируй код из поля.')); }}>Скопировать код</button></div>}
 {!leaving ? <button className="text-button section" disabled={busy} onClick={() => setLeaving(true)}>Выйти из челленджа</button> : <div className="section"><p className="description">Выйти? Сначала дождись сохранения времени в аккаунте. Результат зафиксируется на момент выхода: поздние отправки его не дополнят. Запись участия сохранится. Вернуться в этот челлендж нельзя.{item.isOwner ? ' Приглашение перестанет работать; другие участники останутся.' : ''}</p><button className="secondary section" disabled={busy} onClick={() => void act('leave')}>Да, выйти</button><button className="text-button section" disabled={busy} onClick={() => setLeaving(false)}>Остаться</button></div>}
 </>}{message && <p className="status-banner section" role="status">{message}</p>}
 </ConditionsCard>;
}
function JoinChallenge({ owner, joined }: { owner: string; joined: () => Promise<unknown> }) {
 const [open, setOpen] = useState(false); const [code, setCode] = useState(''); const [item, setItem] = useState<Challenge | null>(null);
 const [nickname, setNickname] = useState(''); const [minutes, setMinutes] = useState<Conditions['minutes']>(20);
 const [busy, setBusy] = useState(false); const [message, setMessage] = useState('');
 async function act(join: boolean) {
  setBusy(true); setMessage('');
  try {
   const result = await challengeAction(owner, { kind: join ? 'join' : 'preview', code: code.trim(), nickname: nickname.trim(), minutes });
   if (join) { await joined(); setItem(null); setOpen(false); setCode(''); setMessage(result.challenge.left ? 'Ты уже вышел из этого челленджа. Повторное вступление недоступно.' : 'Ты в команде. Твоя цель сохранена на весь челлендж.'); }
   else { setItem(result.challenge); }
  } catch (error) { setMessage(errorText(error)); } finally { setBusy(false); }
 }
 return <div className="section">{!open ? <button className="secondary" onClick={() => { setOpen(true); setMessage(''); }}>Вступить по коду</button> : <form className="challenge-form" onSubmit={e => { e.preventDefault(); void act(!!item); }}>
 <h2>Друг уже ждёт.</h2><fieldset disabled={busy}>
 <label className="field-label" htmlFor="invite-code">Код приглашения</label><input id="invite-code" required pattern="[a-f0-9]{48}" maxLength={48} autoCapitalize="none" autoComplete="off" value={code} onChange={e => { setCode(e.target.value.trim()); setItem(null); }} />
 {item && <><p className="description section">{item.name} · {modes[item.mode]}<br />Старт {item.startDay} · {item.duration} дней · {item.timeZone}</p>
 <p className="reader-note">{item.mode === 'competitive' ? `Общая цель: ${item.minutes} мин в день. Места определяются выполненными днями; при равенстве место общее.` : 'Выбери свою цель. В этом формате нет общего рейтинга.'} Цель фиксируется на весь срок. Участникам будут видны твой псевдоним и выполненные дни. Почта и книги скрыты.</p><DatePolicy />
 <label className="field-label" htmlFor="join-nickname">Твой псевдоним в команде</label><input id="join-nickname" required maxLength={40} value={nickname} onChange={e => setNickname(e.target.value)} />
 {item.mode === 'personal' && <><label className="field-label" htmlFor="join-minutes">Твоя цель, минут в день</label><select id="join-minutes" value={minutes} onChange={e => setMinutes(Number(e.target.value) as Conditions['minutes'])}>{[5,10,20,30,60].map(n => <option key={n} value={n}>{n} минут</option>)}</select></>}
 <p className="reader-note">Вступить можно до старта, пока в команде меньше 10 человек. После выхода повторное вступление недоступно.</p></>}
 </fieldset><button className="primary section" disabled={busy}>{busy ? 'Проверяем…' : item ? 'Принять условия и вступить' : 'Посмотреть условия'}</button><button type="button" className="text-button section" disabled={busy} onClick={() => { setOpen(false); setItem(null); }}>Отмена</button></form>}
 {message && <p className="status-banner section" role="status">{message}</p>}</div>;
}
function AccountChallenges({ owner }: { owner: string }) {
 const { settings } = useApp(); const client = useQueryClient();
 const queryKey = ['challenges', owner];
 const query = useQuery({ queryKey, queryFn: ({ signal }) => listChallenges(owner, signal), retry: false, gcTime: 0, networkMode: 'always', refetchInterval: 30000 });
 const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
 const [pending, setPending] = useState(() => { try { return pendingChallenge(owner); } catch { return null; } });
 const [name, setName] = useState(pending?.name ?? ''); const [nickname, setNickname] = useState(pending?.nickname ?? settings.name ?? '');
 const [mode, setMode] = useState<Conditions['mode']>(pending?.mode ?? 'competitive');
 const [minutes, setMinutes] = useState<Conditions['minutes']>(pending?.minutes ?? 20);
 const [duration, setDuration] = useState<Conditions['duration']>(pending?.duration ?? 7);
 const [zone, setZone] = useState(pending?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC');
 const [day, setDay] = useState(pending?.startDay ?? nextGoalDay(goalDay(zone)));
 const [notice, setNotice] = useState('');
 function tomorrow() { try { return nextGoalDay(goalDay(zone)); } catch { return ''; } }
 async function save() {
  if (busy) return; setBusy(true); setError(''); setNotice('');
  try {
   const item = await createChallenge(owner, { name: name.trim(), nickname: nickname.trim(), mode, minutes, duration, timeZone: zone.trim(), startDay: day });
   await client.cancelQueries({ queryKey });
   client.setQueryData<Challenge[]>(queryKey, old => [item, ...(old ?? []).filter(c => c.id !== item.id)]);
   setPending(null); setOpen(false); setName(''); setNotice('Челлендж создан. Условия сохранены в аккаунте.');
  } catch (error) {
   setError(errorText(error));
   try { setPending(pendingChallenge(owner)); } catch { /* Keep error and entered conditions visible. */ }
  } finally { setBusy(false); }
 }
 const showForm = open || !!pending;
 return <><p className="description">Выбери общий план для соревнования или свою цель для личного роста. Читай любые книги.</p><p className="reader-note">Закрытые команды до 10 человек. Участникам видны псевдонимы и выполненные дни. Почта и книги скрыты.</p>{notice && <p className="status-banner section" role="status">{notice}</p>}
 <JoinChallenge owner={owner} joined={() => query.refetch()} />
 {!showForm ? <button className="primary section" onClick={() => { setOpen(true); setNotice(''); }}>Создать челлендж</button> : <form className="challenge-form section" onSubmit={event => { event.preventDefault(); void save(); }}>
 <h2>Твой новый путь.</h2>{pending && <p className="status-banner section">Подтверждение создания ещё не получено. Повтори запрос с теми же условиями — второй челлендж не появится.</p>}
 <fieldset disabled={busy || !!pending}><legend className="field-label">Формат</legend><div className="choice-row">{(Object.keys(modes) as Conditions['mode'][]).map(value => <button key={value} type="button" className={`pill ${mode === value ? 'active' : ''}`} aria-pressed={mode === value} onClick={() => setMode(value)}>{modes[value]}</button>)}</div>
 <p className="description">{mode === 'competitive' ? 'Одинаковая цель для всех. Побеждает тот, кто выполнил её в большем числе дней. При равенстве — общее место. Минуты сверх цели преимущества не дают.' : 'У каждого своя цель. Здесь нет рейтинга между участниками — каждый идёт в своём ритме.'}</p>
 <label className="field-label" htmlFor="challenge-name">Название</label><input id="challenge-name" required maxLength={60} value={name} onChange={e => setName(e.target.value)} />
 <label className="field-label" htmlFor="challenge-nickname">Твой псевдоним в команде</label><input id="challenge-nickname" required maxLength={40} autoComplete="nickname" value={nickname} onChange={e => setNickname(e.target.value)} />
 <label className="field-label" htmlFor="challenge-minutes">{mode === 'competitive' ? 'Общая цель, минут в день' : 'Твоя цель, минут в день'}</label><select id="challenge-minutes" value={minutes} onChange={e => setMinutes(Number(e.target.value) as Conditions['minutes'])}>{[5,10,20,30,60].map(n => <option key={n} value={n}>{n} минут</option>)}</select>
 <label className="field-label" htmlFor="challenge-duration">Длительность</label><select id="challenge-duration" value={duration} onChange={e => setDuration(Number(e.target.value) as Conditions['duration'])}>{[7,14,30].map(n => <option key={n} value={n}>{n} дней</option>)}</select>
 <label className="field-label" htmlFor="challenge-zone">Общий часовой пояс</label><input id="challenge-zone" required maxLength={100} list="challenge-zones" value={zone} onChange={e => setZone(e.target.value)} /><datalist id="challenge-zones">{['Europe/Moscow','Europe/Kaliningrad','Asia/Yekaterinburg','Asia/Novosibirsk','Asia/Vladivostok','UTC'].map(z => <option key={z} value={z} />)}</datalist>
 <label className="field-label" htmlFor="challenge-day">Дата старта</label><input id="challenge-day" required type="date" min={tomorrow()} value={day} onChange={e => setDay(e.target.value)} />
 <p className="description">Цель фиксируется на весь срок. Изменение обычной дневной цели не меняет условия челленджа.</p><DatePolicy /></fieldset>
 {error && <p className="status-banner section" role="alert">{error}</p>}<button className="primary section" disabled={busy} aria-busy={busy}>{busy ? 'Сохраняем…' : pending ? 'Повторить создание' : 'Сохранить челлендж'}</button>{!pending && <button type="button" className="secondary section" disabled={busy} onClick={() => { setOpen(false); setError(''); }}>Отмена</button>}</form>}
 <div className="section-head section"><h3>Твои челленджи</h3><button className="text-button" disabled={query.isFetching || busy} onClick={() => void query.refetch()}>Обновить</button></div>
 {query.isPending ? <p className="description" role="status">Загружаем челленджи…</p> : query.isError ? <p className="status-banner" role="alert">{errorText(query.error)}</p> : !query.data.length && <p className="description">Здесь появится твой первый челлендж.</p>}
 {!query.isError && query.data?.map(item => <MembershipCard key={item.id} item={item} owner={owner} refresh={() => query.refetch()} />)}</>;
}
export function Challenges() {
 const account = useAccount();
 return <><p className="eyebrow muted">Читай. Поддерживай. Расти.</p><div className="challenge-heading section"><h1>У историй есть<br />сила <em className="serif">сближать.</em></h1></div>{account.checking ? <p className="description" role="status">Проверяем вход…</p> : account.session ? <AccountChallenges key={account.session.user.id} owner={account.session.user.id} /> : <div className="expedition"><h2>Вместе — легче.</h2><p className="description">Соревнуйся с общей целью или двигайся в своём ритме с личной. Созданные челленджи сохраняются в аккаунте.</p>{account.error && <p className="status-banner" role="alert">Не удалось проверить вход. Для челленджей нужно подключение к сервису.</p>}<Link className="primary" to="/login">Войти по почте</Link></div>}</>;
}
