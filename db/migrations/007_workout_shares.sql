CREATE TABLE IF NOT EXISTS workout_shares (
  id text PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  payload jsonb NOT NULL,
  views integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
