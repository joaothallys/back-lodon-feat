const crypto = require("node:crypto");
const { one, pool } = require("../../db/pool");
const { ok, readJson, matchPath, httpError } = require("../../lib/http");
const { requireUser } = require("../../lib/auth");

const ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_ITEMS = 40;
const MAX_SETS = 20;

let tableReady = null;

function ensureTable() {
  if (!tableReady) {
    tableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS workout_shares (
        id text PRIMARY KEY,
        user_id uuid REFERENCES users(id) ON DELETE SET NULL,
        payload jsonb NOT NULL,
        views integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `).catch((err) => {
      tableReady = null;
      throw err;
    });
  }
  return tableReady;
}

function shortId(size = 8) {
  const bytes = crypto.randomBytes(size);
  let out = "";
  for (let i = 0; i < size; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function text(value, max) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

function num(value, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, max);
}

function httpsUrl(value) {
  const s = text(value, 500);
  return /^https:\/\//i.test(s) ? s : "";
}

function normalizePayload(body) {
  const items = (Array.isArray(body.items) ? body.items : []).slice(0, MAX_ITEMS).map((it) => ({
    id: text(it.id, 80),
    sourceId: text(it.sourceId, 40),
    name: text(it.name, 120),
    muscle: text(it.muscle, 40),
    equipment: text(it.equipment, 60),
    gifUrl: httpsUrl(it.gifUrl),
    rest: num(it.rest, 900),
    sets: (Array.isArray(it.sets) ? it.sets : []).slice(0, MAX_SETS).map((s) => ({
      type: text(s.type, 2) || "N",
      kg: num(s.kg, 1000),
      reps: num(s.reps, 200)
    }))
  })).filter((it) => it.id && it.name);
  if (!items.length) throw httpError(400, "treino sem exercícios");
  return {
    kind: "workout",
    name: text(body.name, 80) || "Treino",
    author: text(body.author, 40),
    items
  };
}

async function handle(req, res, url) {
  const pathname = url.pathname;

  if (req.method === "POST" && matchPath(pathname, "/api/shares")) {
    const user = await requireUser(req);
    const payload = normalizePayload(await readJson(req));
    await ensureTable();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = shortId();
      const row = await one(
        `INSERT INTO workout_shares (id, user_id, payload) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO NOTHING
         RETURNING id, created_at`,
        [id, user.id, payload]
      );
      if (row) return ok(res, { data: { id: row.id, createdAt: row.created_at } }, 201);
    }
    throw httpError(500, "não foi possível gerar o link");
  }

  const params = req.method === "GET" && matchPath(pathname, "/api/shares/:id");
  if (params) {
    await ensureTable();
    const row = await one(
      `UPDATE workout_shares SET views = views + 1 WHERE id = $1
       RETURNING id, payload, views, created_at`,
      [text(params.id, 20)]
    );
    if (!row) throw httpError(404, "treino compartilhado não encontrado");
    return ok(res, { data: { id: row.id, ...row.payload, views: row.views, createdAt: row.created_at } });
  }

  return false;
}

module.exports = { handle };
