ALTER TABLE workout_plan_days
  ADD COLUMN weekdays smallint[] NOT NULL DEFAULT '{}';

ALTER TABLE workout_plan_days
  ADD CONSTRAINT workout_plan_days_weekdays_range
  CHECK (weekdays <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::smallint[]);
