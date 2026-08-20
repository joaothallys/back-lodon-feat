CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  phone text,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'aluno' CHECK (role IN ('aluno', 'admin')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked', 'deleted')),
  onboarding_done boolean NOT NULL DEFAULT false,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  refresh_token_hash text NOT NULL,
  device text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_user_sessions_user ON user_sessions (user_id);
CREATE INDEX idx_user_sessions_hash ON user_sessions (refresh_token_hash);

CREATE TABLE user_profiles (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  name text NOT NULL,
  gender text CHECK (gender IN ('male', 'female', 'other') OR gender IS NULL),
  goal text NOT NULL DEFAULT 'hipertrofia'
    CHECK (goal IN ('hipertrofia', 'forca', 'emagrecimento', 'definicao', 'condicionamento', 'manutencao')),
  level text NOT NULL DEFAULT 'iniciante'
    CHECK (level IN ('iniciante', 'intermediario', 'avancado')),
  environment text NOT NULL DEFAULT 'academia'
    CHECK (environment IN ('academia', 'casa', 'peso-corporal')),
  training_days int NOT NULL DEFAULT 4 CHECK (training_days BETWEEN 3 AND 6),
  session_duration_min int NOT NULL DEFAULT 60,
  rest_default_sec int NOT NULL DEFAULT 90,
  sound_enabled boolean NOT NULL DEFAULT true,
  reminders boolean NOT NULL DEFAULT false,
  language text NOT NULL DEFAULT 'pt-BR',
  unit_kg boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_profile_equipment (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  equipment_id text NOT NULL,
  PRIMARY KEY (user_id, equipment_id)
);

CREATE TABLE user_profile_focus (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  muscle_id text NOT NULL,
  PRIMARY KEY (user_id, muscle_id)
);

CREATE TABLE gym_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  address text,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE membership_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  interval text NOT NULL CHECK (interval IN ('monthly', 'quarterly', 'yearly')),
  amount numeric(10, 2) NOT NULL,
  currency text NOT NULL DEFAULT 'BRL',
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES membership_plans (id),
  unit_id uuid REFERENCES gym_units (id),
  member_code text UNIQUE,
  status text NOT NULL DEFAULT 'ativa'
    CHECK (status IN ('ativa', 'atrasada', 'cancelada', 'expirada')),
  started_at date NOT NULL DEFAULT CURRENT_DATE,
  expires_at date,
  next_payment_at date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_memberships_user ON memberships (user_id);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  membership_id uuid NOT NULL REFERENCES memberships (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  amount numeric(10, 2) NOT NULL,
  due_date date NOT NULL,
  paid_at date,
  status text NOT NULL DEFAULT 'em_aberto'
    CHECK (status IN ('pago', 'em_aberto', 'atrasado', 'cancelado')),
  method text CHECK (method IN ('pix', 'card', 'boleto', 'cash') OR method IS NULL),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_payments_membership ON payments (membership_id);
CREATE INDEX idx_payments_user ON payments (user_id);

CREATE TABLE user_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('gym', 'home')),
  is_active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_user_locations_user ON user_locations (user_id);

CREATE TABLE user_location_equipment (
  location_id uuid NOT NULL REFERENCES user_locations (id) ON DELETE CASCADE,
  equipment_id text NOT NULL,
  PRIMARY KEY (location_id, equipment_id)
);

CREATE TABLE workout_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name text NOT NULL,
  source text NOT NULL CHECK (source IN ('ia', 'program', 'custom')),
  program_id text,
  goal text,
  level text,
  days_per_week int,
  is_active boolean NOT NULL DEFAULT true,
  generated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uniq_active_plan_per_user
  ON workout_plans (user_id) WHERE is_active = true;

CREATE TABLE workout_plan_days (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES workout_plans (id) ON DELETE CASCADE,
  position int NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workout_plan_day_focus (
  day_id uuid NOT NULL REFERENCES workout_plan_days (id) ON DELETE CASCADE,
  muscle_id text NOT NULL,
  PRIMARY KEY (day_id, muscle_id)
);

CREATE TABLE workout_plan_exercises (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  day_id uuid NOT NULL REFERENCES workout_plan_days (id) ON DELETE CASCADE,
  position int NOT NULL,
  exercise_id text NOT NULL,
  sets int NOT NULL,
  reps int NOT NULL,
  kg numeric(6, 2) NOT NULL DEFAULT 0,
  rest_sec int NOT NULL DEFAULT 90
);

CREATE TABLE custom_workouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name text NOT NULL,
  is_favorite boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX idx_custom_workouts_user ON custom_workouts (user_id) WHERE deleted_at IS NULL;

CREATE TABLE custom_workout_exercises (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workout_id uuid NOT NULL REFERENCES custom_workouts (id) ON DELETE CASCADE,
  position int NOT NULL,
  exercise_id text NOT NULL,
  sets int NOT NULL,
  reps int NOT NULL,
  kg numeric(6, 2) NOT NULL DEFAULT 0,
  rest_sec int NOT NULL DEFAULT 90
);

CREATE TABLE workout_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN ('plan_day', 'custom', 'fast', 'single')),
  source_id uuid,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'completed', 'abandoned')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_min int,
  volume_kg numeric(12, 2) NOT NULL DEFAULT 0,
  calories int,
  exercises_count int NOT NULL DEFAULT 0,
  sets_count int NOT NULL DEFAULT 0,
  best_weight numeric(6, 2),
  best_reps int,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uniq_in_progress_session_per_user
  ON workout_sessions (user_id) WHERE status = 'in_progress' AND deleted_at IS NULL;

CREATE INDEX idx_workout_sessions_user ON workout_sessions (user_id, started_at DESC);

CREATE TABLE workout_session_exercises (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES workout_sessions (id) ON DELETE CASCADE,
  position int NOT NULL,
  exercise_id text NOT NULL,
  rest_sec int,
  replaced_from_exercise_id text
);

CREATE TABLE workout_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_exercise_id uuid NOT NULL REFERENCES workout_session_exercises (id) ON DELETE CASCADE,
  position int NOT NULL,
  type text NOT NULL CHECK (type IN ('W', 'N', 'D', 'S')),
  kg numeric(6, 2) NOT NULL,
  reps int NOT NULL,
  done boolean NOT NULL DEFAULT false,
  completed_at timestamptz
);

CREATE TABLE muscle_recovery (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  muscle_id text NOT NULL,
  last_trained_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, muscle_id)
);

CREATE TABLE body_measurements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  height_cm numeric(5, 2),
  weight_kg numeric(5, 2),
  weight_goal_kg numeric(5, 2),
  measured_at date NOT NULL DEFAULT CURRENT_DATE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_body_measurements_user ON body_measurements (user_id, measured_at DESC);

CREATE TABLE exercise_favorites (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  exercise_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, exercise_id)
);

CREATE TABLE exercise_feedback (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  exercise_id text NOT NULL,
  feedback text NOT NULL CHECK (feedback IN ('positive', 'negative')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, exercise_id)
);

CREATE TABLE analytics_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  event text NOT NULL,
  exercise_id text,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_analytics_user ON analytics_events (user_id, created_at DESC);

CREATE TABLE connected_apps (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  app text NOT NULL CHECK (app IN ('apple_health', 'strava')),
  status text NOT NULL CHECK (status IN ('connected', 'disconnected')),
  connected_at timestamptz,
  PRIMARY KEY (user_id, app)
);
