const { Pool, types } = require("pg");

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
  console.error("postgres:", err.message);
});

async function one(text, params) {
  const result = await pool.query(text, params);
  return result.rows[0] || null;
}

async function many(text, params) {
  const result = await pool.query(text, params);
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
