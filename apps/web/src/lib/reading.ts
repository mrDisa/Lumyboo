export function localDay(date = new Date()) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
// performance.now is monotonic; wall-clock edits cannot add minutes.
export class ReadingClock {
  private previous: number | null = null;
  tick(now: number, active: boolean): number {
    const delta = this.previous === null ? 0 : Math.max(0, now - this.previous);
    this.previous = active ? now : null;
    // A suspended process must never credit the entire suspension.
    return delta <= 5000 ? delta / 1000 : 0;
  }
  pause() { this.previous = null; }
}

// Sum in integer milliseconds so many short sessions cannot lose a minute to float rounding.
export function sumReadingSeconds(sessions: { seconds: number }[]) {
  return sessions.reduce((sum, session) => sum + Math.round(session.seconds * 1000), 0) / 1000;
}
