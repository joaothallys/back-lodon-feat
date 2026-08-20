const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto");

const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "app.sqlite");

function open() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS exercises (
      id TEXT PRIMARY KEY,
      external_id TEXT NOT NULL,
      original_name TEXT NOT NULL,
      localized_name TEXT,
      gif_url TEXT,
      video_url TEXT,
      body_parts TEXT NOT NULL DEFAULT '[]',
      equipments TEXT NOT NULL DEFAULT '[]',
      target_muscles TEXT NOT NULL DEFAULT '[]',
      secondary_muscles TEXT NOT NULL DEFAULT '[]',
      instructions TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'exercisedb',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (source, external_id)
    );

    CREATE INDEX IF NOT EXISTS idx_exercises_name ON exercises (original_name);
    CREATE INDEX IF NOT EXISTS idx_exercises_source ON exercises (source);

    CREATE TABLE IF NOT EXISTS gif_fallbacks (
      query_key TEXT PRIMARY KEY,
      gif_url TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'tenor',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sync_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_sync_at INTEGER,
      last_error TEXT,
      last_report TEXT
    );

    INSERT OR IGNORE INTO sync_meta (id, last_sync_at, last_error, last_report)
    VALUES (1, NULL, NULL, NULL);
  `);
  return db;
}

const db = open();

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value || "null");
    return parsed == null ? fallback : parsed;
  } catch (e) {
    return fallback;
  }
}

function rowToExercise(row) {
  if (!row) return null;
  return {
    id: row.id,
    externalId: row.external_id,
    name: row.original_name,
    originalName: row.original_name,
    localizedName: row.localized_name,
    gifUrl: row.gif_url || null,
    videoUrl: row.video_url || null,
    bodyParts: parseJson(row.body_parts, []),
    equipments: parseJson(row.equipments, []),
    targetMuscles: parseJson(row.target_muscles, []),
    secondaryMuscles: parseJson(row.secondary_muscles, []),
    instructions: parseJson(row.instructions, []),
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const selectBySourceExternal = db.prepare(
  "SELECT * FROM exercises WHERE source = ? AND external_id = ?"
);
const insertExercise = db.prepare(`
  INSERT INTO exercises (
    id, external_id, original_name, localized_name, gif_url, video_url,
    body_parts, equipments, target_muscles, secondary_muscles, instructions,
    source, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateExercise = db.prepare(`
  UPDATE exercises SET
    original_name = ?,
    gif_url = ?,
    body_parts = ?,
    equipments = ?,
    target_muscles = ?,
    secondary_muscles = ?,
    instructions = ?,
    updated_at = ?
  WHERE source = ? AND external_id = ?
`);

function upsertManyFromExerciseDB(rows) {
  const stats = { created: 0, updated: 0, failed: 0 };
  db.exec("BEGIN");
  try {
    (rows || []).forEach((raw) => {
      const kind = upsertFromExerciseDB(raw);
      if (kind === "created") stats.created += 1;
      else if (kind === "updated") stats.updated += 1;
      else stats.failed += 1;
    });
    db.exec("COMMIT");
    return stats;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function upsertFromExerciseDB(raw) {
  if (!raw || !raw.exerciseId) return "failed";
  const now = Date.now();
  const existing = selectBySourceExternal.get("exercisedb", raw.exerciseId);
  const originalName = raw.name || existing && existing.original_name || "untitled";
  const gifUrl = raw.gifUrl || null;
  const bodyParts = JSON.stringify(raw.bodyParts || []);
  const equipments = JSON.stringify(raw.equipments || []);
  const targetMuscles = JSON.stringify(raw.targetMuscles || []);
  const secondaryMuscles = JSON.stringify(raw.secondaryMuscles || []);
  const instructions = JSON.stringify(Array.isArray(raw.instructions) ? raw.instructions : []);

  if (!existing) {
    insertExercise.run(
      crypto.randomUUID(),
      raw.exerciseId,
      originalName,
      null,
      gifUrl,
      null,
      bodyParts,
      equipments,
      targetMuscles,
      secondaryMuscles,
      instructions,
      "exercisedb",
      now,
      now
    );
    return "created";
  }

  updateExercise.run(
    originalName,
    gifUrl,
    bodyParts,
    equipments,
    targetMuscles,
    secondaryMuscles,
    instructions,
    now,
    "exercisedb",
    raw.exerciseId
  );
  return "updated";
}

function searchTerms(search) {
  const q = String(search || "").toLowerCase().trim();
  if (!q) return [];
  const extra = [];
  const map = [
    ["halter", "dumbbell"],
    ["barra w", "ez barbell"],
    ["barra", "barbell"],
    ["polia", "cable"],
    ["elástico", "band"],
    ["peso corporal", "body weight"],
    ["máquina", "machine"],
    ["supino", "press"],
    ["agachamento", "squat"],
    ["remada", "row"],
    ["rosca", "curl"],
    ["elevação", "raise"],
    ["desenvolvimento", "press"],
    ["terra", "deadlift"],
    ["afundo", "lunge"],
    ["crucifixo", "fly"],
    ["extensão", "extension"],
    ["flexão", "push"],
    ["barra fixa", "pull"],
    ["mergulho", "dip"],
    ["panturrilha", "calf"],
    ["abdominal", "crunch"],
    ["prancha", "plank"],
    ["puxada", "pulldown"],
    ["tríceps", "triceps"],
    ["triceps", "triceps"],
    ["bíceps", "biceps"],
    ["biceps", "biceps"],
    ["ombro", "shoulder"],
    ["peito", "chest"],
    ["costas", "row"],
    ["posterior", "hamstring"],
    ["glúteo", "glute"],
    ["quadril", "hip"]
  ];
  map.forEach(([pt, en]) => {
    if (q.indexOf(pt) >= 0) extra.push(en);
  });
  return [q].concat(extra.filter((term, i, arr) => arr.indexOf(term) === i && term !== q));
}

function list({ page, limit, search, bodyPart, equipment, targetMuscle }) {
  const clauses = [];
  const params = [];

  const terms = searchTerms(search);
  if (terms.length) {
    clauses.push("(" + terms.map(() => "lower(original_name) LIKE ?").join(" OR ") + ")");
    terms.forEach((term) => params.push("%" + term + "%"));
  }
  if (bodyPart) {
    clauses.push("lower(body_parts) LIKE ?");
    params.push('%"' + String(bodyPart).toLowerCase() + '"%');
  }
  if (equipment) {
    clauses.push("lower(equipments) LIKE ?");
    params.push('%"' + String(equipment).toLowerCase() + '"%');
  }
  if (targetMuscle) {
    clauses.push("lower(target_muscles) LIKE ?");
    params.push('%"' + String(targetMuscle).toLowerCase() + '"%');
  }

  const where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
  const total = db.prepare("SELECT COUNT(*) AS n FROM exercises" + where).get(...params).n;
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  const safePage = Math.max(1, Number(page) || 1);
  const offset = (safePage - 1) * safeLimit;
  const rows = db.prepare(
    "SELECT * FROM exercises" + where + " ORDER BY original_name COLLATE NOCASE LIMIT ? OFFSET ?"
  ).all(...params, safeLimit, offset);

  return {
    data: rows.map(rowToExercise),
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.max(1, Math.ceil(total / safeLimit))
    }
  };
}

function getByExternalId(id) {
  const row = db.prepare("SELECT * FROM exercises WHERE external_id = ? LIMIT 1").get(id);
  return rowToExercise(row);
}

function uniqueValues(column) {
  const rows = db.prepare("SELECT " + column + " AS raw FROM exercises").all();
  const set = new Set();
  rows.forEach((row) => {
    parseJson(row.raw, []).forEach((value) => {
      if (value) set.add(String(value));
    });
  });
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

function getFilters() {
  return {
    bodyParts: uniqueValues("body_parts"),
    equipments: uniqueValues("equipments"),
    targetMuscles: uniqueValues("target_muscles")
  };
}

function count() {
  return db.prepare("SELECT COUNT(*) AS n FROM exercises").get().n;
}

function getSyncMeta() {
  const row = db.prepare("SELECT * FROM sync_meta WHERE id = 1").get();
  return {
    lastSyncAt: row && row.last_sync_at,
    lastError: row && row.last_error,
    lastReport: parseJson(row && row.last_report, null)
  };
}

function setSyncMeta({ lastSyncAt, lastError, lastReport }) {
  db.prepare(
    "UPDATE sync_meta SET last_sync_at = ?, last_error = ?, last_report = ? WHERE id = 1"
  ).run(lastSyncAt || null, lastError || null, lastReport ? JSON.stringify(lastReport) : null);
}

function getGifFallback(queryKey) {
  const row = db.prepare("SELECT gif_url, source FROM gif_fallbacks WHERE query_key = ?").get(queryKey);
  if (!row) return null;
  return { gifUrl: row.gif_url, source: row.source };
}

function setGifFallback(queryKey, gifUrl, source) {
  db.prepare(`
    INSERT INTO gif_fallbacks (query_key, gif_url, source, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(query_key) DO UPDATE SET gif_url = excluded.gif_url, source = excluded.source
  `).run(queryKey, gifUrl, source || "tenor", Date.now());
}

module.exports = {
  upsertFromExerciseDB,
  upsertManyFromExerciseDB,
  list,
  getByExternalId,
  getFilters,
  count,
  getSyncMeta,
  setSyncMeta,
  getGifFallback,
  setGifFallback
};
