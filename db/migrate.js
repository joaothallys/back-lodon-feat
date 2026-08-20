const fs = require("node:fs");
const path = require("node:path");
const { loadEnv } = require("../load-env");

loadEnv(".env");

const { pool } = require("./pool");

async function migrate() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL não configurada");
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const dir = path.join(__dirname, "migrations");
  const files = fs.readdirSync(dir).filter((file) => file.endsWith(".sql")).sort();

  for (const file of files) {
    const applied = await pool.query("SELECT 1 FROM schema_migrations WHERE id = $1", [file]);
    if (applied.rowCount) {
      console.log("skip  " + file);
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    await pool.query(sql);
    await pool.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
    console.log("ok    " + file);
  }
}

migrate()
  .then(async () => {
    console.log("migrations concluídas");
    await pool.end();
  })
  .catch(async (err) => {
    console.error(err.message || err);
    try { await pool.end(); } catch (_) {}
    process.exit(1);
  });
