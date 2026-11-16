BEGIN;
-- Freeze accepted progress when a reader leaves. Ordinary reading stays intact.
ALTER TABLE challenge_members ADD COLUMN days_at_exit jsonb;
-- Older departures have no snapshot. Preserve the currently stored totals
-- through their departure date; do not let later uploads change them again.
UPDATE challenge_members p SET days_at_exit = (
 SELECT jsonb_agg(jsonb_build_object('day',to_char(d.day,'YYYY-MM-DD'),
 'milliseconds',COALESCE(t.ms,0),'complete',COALESCE(t.ms,0)>=p.minutes*60000) ORDER BY d.day)
 FROM generate_series(c.start_day::timestamp,(c.start_day+c.duration-1)::timestamp,interval '1 day') d(day)
 LEFT JOIN LATERAL (
  SELECT sum(r.milliseconds)::bigint AS ms FROM reading_sessions r
  WHERE r.user_id=p.user_id AND r.reported_day=d.day::date
  AND r.reported_day <= (p.left_at AT TIME ZONE c.time_zone)::date
 ) t ON true
) FROM challenges c WHERE p.challenge_id=c.id AND p.left_at IS NOT NULL;
COMMIT;
