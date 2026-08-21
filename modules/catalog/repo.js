const fs = require("node:fs");
const path = require("node:path");
const { many, pool } = require("../../db/pool");

async function seedCatalog() {
  const file = path.join(__dirname, "london.json");
  const rows = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!rows.length) return 0;
  const params = [];
  const values = rows.map((row, index) => {
    const offset = index * 6;
    params.push(row.id, row.displayName, row.muscle, row.equipment, row.level, row.popularity || 0);
    return "($" + (offset + 1) + ", $" + (offset + 2) + ", $" + (offset + 3) + ", $" + (offset + 4) + ", $" + (offset + 5) + ", $" + (offset + 6) + ", true)";
  });
  await pool.query(
    `INSERT INTO catalog_exercises (id, display_name, muscle_id, equipment_id, level, popularity, is_active)
     VALUES ` + values.join(", ") + `
     ON CONFLICT (id) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       muscle_id = EXCLUDED.muscle_id,
       equipment_id = EXCLUDED.equipment_id,
       level = EXCLUDED.level,
       popularity = EXCLUDED.popularity,
       is_active = true`,
    params
  );
  return rows.length;
}

async function muscleCounts() {
  return many(
    `SELECT muscle_id AS muscle, count(*)::int AS total
     FROM catalog_exercises
     WHERE is_active = true
     GROUP BY muscle_id
     ORDER BY muscle_id`
  );
}

async function listActive() {
  return many(
    `SELECT id, display_name, muscle_id, equipment_id, level, popularity
     FROM catalog_exercises
     WHERE is_active = true
     ORDER BY muscle_id, popularity DESC`
  );
}

function promptLines(rows) {
  return rows
    .map((row) => [row.id, row.display_name, row.muscle_id, row.equipment_id, row.level].join(" | "))
    .join("\n");
}

module.exports = { seedCatalog, listActive, promptLines, muscleCounts };
