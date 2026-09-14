ALTER TABLE users
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_users_deleted_at ON users (deleted_at)
  WHERE deleted_at IS NOT NULL;
