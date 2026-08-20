const { one, pool } = require("../../db/pool");
const { ok, readJson, matchPath, required } = require("../../lib/http");
const { requireUser, publicUser, loadProfileExtras } = require("../../lib/auth");

const PROFILE_FIELDS = [
  ["name", "name"],
  ["gender", "gender"],
  ["goal", "goal"],
  ["level", "level"],
  ["environment", "environment"],
  ["trainingDays", "training_days"],
  ["sessionDurationMin", "session_duration_min"],
  ["restDefaultSec", "rest_default_sec"],
  ["soundEnabled", "sound_enabled"],
  ["reminders", "reminders"],
  ["language", "language"],
  ["unitKg", "unit_kg"]
];

async function replaceList(client, table, column, userId, values) {
  await client.query("DELETE FROM " + table + " WHERE user_id = $1", [userId]);
  const items = Array.isArray(values) ? values.filter(Boolean) : [];
  for (const value of items) {
    await client.query(
      "INSERT INTO " + table + " (user_id, " + column + ") VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [userId, String(value)]
    );
  }
}

async function saveProfile(userId, body, markOnboarding) {
  const sets = [];
  const params = [];
  PROFILE_FIELDS.forEach(([from, column]) => {
    if (body[from] !== undefined) {
      params.push(body[from]);
      sets.push(column + " = $" + params.length);
    }
  });
  params.push(userId);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (sets.length) {
      await client.query(
        "UPDATE user_profiles SET " + sets.join(", ") + ", updated_at = now() WHERE user_id = $" + params.length,
        params
      );
    }
    if (body.equipment) await replaceList(client, "user_profile_equipment", "equipment_id", userId, body.equipment);
    if (body.focus) await replaceList(client, "user_profile_focus", "muscle_id", userId, body.focus);
    if (markOnboarding) {
      await client.query("UPDATE users SET onboarding_done = true, updated_at = now() WHERE id = $1", [userId]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function handle(req, res, url) {
  const pathname = url.pathname;

  if (req.method === "GET" && matchPath(pathname, "/api/profile")) {
    const user = await requireUser(req);
    return ok(res, { data: await publicUser(user) });
  }

  if (req.method === "PUT" && matchPath(pathname, "/api/profile")) {
    const user = await requireUser(req);
    const body = await readJson(req);
    await saveProfile(user.id, body, false);
    const fresh = await one("SELECT * FROM users WHERE id = $1", [user.id]);
    return ok(res, { data: await publicUser(fresh) });
  }

  if (req.method === "POST" && matchPath(pathname, "/api/profile/onboarding")) {
    const user = await requireUser(req);
    const body = await readJson(req);
    required(body, ["name", "goal", "level", "environment", "trainingDays", "sessionDurationMin"]);
    await saveProfile(user.id, body, true);
    const fresh = await one("SELECT * FROM users WHERE id = $1", [user.id]);
    return ok(res, { data: await publicUser(fresh) });
  }

  if (req.method === "PUT" && matchPath(pathname, "/api/profile/equipment")) {
    const user = await requireUser(req);
    const body = await readJson(req);
    const client = await pool.connect();
    try {
      await replaceList(client, "user_profile_equipment", "equipment_id", user.id, body.equipment || body.items);
    } finally {
      client.release();
    }
    return ok(res, { data: await loadProfileExtras(user.id) });
  }

  if (req.method === "PUT" && matchPath(pathname, "/api/profile/focus")) {
    const user = await requireUser(req);
    const body = await readJson(req);
    const client = await pool.connect();
    try {
      await replaceList(client, "user_profile_focus", "muscle_id", user.id, body.focus || body.items);
    } finally {
      client.release();
    }
    return ok(res, { data: await loadProfileExtras(user.id) });
  }

  return false;
}

module.exports = { handle };
