import { readingDuration } from '../lib/reading-session-history';

export function DayProgress({ milliseconds, minutes, complete, label, progressLabel }: {
 milliseconds: number; minutes: number; complete: boolean; label: string; progressLabel: string;
}) {
 return <div className={`day-progress-card${complete ? ' is-complete' : ''}`}>
  <p className="eyebrow">{label}</p>
  <div className="day-progress-score"><strong>{Math.floor(milliseconds / 60000)}</strong><span>из {minutes}<small>минут сегодня</small></span></div>
  <progress className="goal-progress" aria-label={progressLabel} max={minutes * 60000} value={Math.min(milliseconds, minutes * 60000)} />
  <p className="day-progress-caption">{complete ? 'Цель выполнена ✓' : `Ещё ${readingDuration(Math.max(0, minutes * 60000 - milliseconds))} для себя`}</p>
 </div>;
}
