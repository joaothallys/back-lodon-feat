const { Pool, types } = require("pg");
const { log } = require("../lib/logger");

types.setTypeParser(1700, (value) => (value == null ? null : Number(value)));

const ssl = process.env.DATABASE_SSL === "false"
  ? false
  : { rejectUnauthorized: false };

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl,
  max: 10
});

pool.on("error", (err) => {
  log.error("postgres.pool", log.errFields(err));
});

async function query(text, params) {
  const started = Date.now();
  try {
    const result = await pool.query(text, params);
    const ms = Date.now() - started;
    if (ms >= 500) {
      log.warn("postgres.slow", { ms, sql: String(text).replace(/\s+/g, " ").slice(0, 160) });
    }
    return result;
  } catch (err) {
    log.error("postgres.query", {
      ...log.errFields(err),
      sql: String(text).replace(/\s+/g, " ").slice(0, 160)
    });
    throw err;
  }
}

async function one(text, params) {
  const result = await query(text, params);
  return result.rows[0] || null;
}

async function many(text, params) {
  const result = await query(text, params);
  return result.rows;
}

function camelKey(key) {
  return key.replace(/_([a-z])/g, (_, char) => char.toUpperCase());
}

function camel(row) {
  if (!row) return null;
  if (Array.isArray(row)) return row.map(camel);
  const out = {};
  Object.entries(row).forEach(([key, value]) => {
    out[camelKey(key)] = value;
  });
  return out;
}

module.exports = { pool, one, many, camel };
