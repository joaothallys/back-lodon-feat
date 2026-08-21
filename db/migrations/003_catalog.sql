CREATE TABLE catalog_exercises (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  muscle_id text NOT NULL,
  equipment_id text NOT NULL,
  level text NOT NULL DEFAULT 'intermediario'
    CHECK (level IN ('iniciante', 'intermediario', 'avancado')),
  popularity int NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true
);

CREATE INDEX idx_catalog_muscle ON catalog_exercises (muscle_id) WHERE is_active = true;
CREATE INDEX idx_catalog_equipment ON catalog_exercises (equipment_id) WHERE is_active = true;
