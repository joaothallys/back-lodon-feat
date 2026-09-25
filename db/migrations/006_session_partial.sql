ALTER TABLE workout_sessions
  DROP CONSTRAINT IF EXISTS workout_sessions_status_check;

ALTER TABLE workout_sessions
  ADD CONSTRAINT workout_sessions_status_check
  CHECK (status IN ('in_progress', 'completed', 'partial', 'abandoned'));
