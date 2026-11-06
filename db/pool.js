const { Pool, types } = require("pg");
const { log } = require("../lib/logger");

types.setTypeParser(1700, (value) => (value == null ? null : Number(value)));

function caFromEnv(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("-----BEGIN")) return raw.replace(/\\n/g, "\n");
  return Buffer.from(raw, "base64").toString("utf8");
}

function sslConfig(env = process.env) {
  if (env.DATABASE_SSL === "false") return false;
  const ca = caFromEnv(env.DATABASE_CA_CERT);
  if (!ca) {
    log.warn("postgres.tls_unverified", { hint: "defina DATABASE_CA_CERT" });
    return { rejectUnauthorized: false };
  }
  // O Postgres do Railway usa um CA próprio e um certificado emitido para
  // "localhost". Validamos a cadeia contra esse CA; o nome nunca bateria com o proxy.
  return { ca, rejectUnauthorized: true, checkServerIdentity: () => undefined };
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig(),
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

module.exports = { pool, one, many, camel, sslConfig };
