const { one, many, camel } = require("../../db/pool");
const { ok, readJson, matchPath, required, httpError } = require("../../lib/http");
const { requireUser } = require("../../lib/auth");

async function handle(req, res, url) {
  const pathname = url.pathname;

  if (req.method === "GET" && matchPath(pathname, "/api/recovery")) {
    const user = await requireUser(req);
    const rows = await many(
      "SELECT * FROM muscle_recovery WHERE user_id = $1 ORDER BY last_trained_at DESC",
      [user.id]
    );
    return ok(res, { data: camel(rows) });
  }

  if (req.method === "PUT" && matchPath(pathname, "/api/recovery")) {
    const user = await requireUser(req);
    const body = await readJson(req);
    required(body, ["muscleId"]);
    const row = await one(
      `INSERT INTO muscle_recovery (user_id, muscle_id, last_trained_at)
       VALUES ($1, $2, COALESCE($3::timestamptz, now()))
       ON CONFLICT (user_id, muscle_id)
       DO UPDATE SET last_trained_at = EXCLUDED.last_trained_at
       RETURNING *`,
      [user.id, body.muscleId, body.lastTrainedAt || null]
    );
    return ok(res, { data: camel(row) });
  }

  if (req.method === "GET" && matchPath(pathname, "/api/body")) {
    const user = await requireUser(req);
    const rows = await many(
      "SELECT * FROM body_measurements WHERE user_id = $1 ORDER BY measured_at DESC, created_at DESC LIMIT 50",
      [user.id]
    );
    return ok(res, { data: camel(rows), current: rows[0] ? camel(rows[0]) : null });
  }

  if (req.method === "POST" && matchPath(pathname, "/api/body")) {
    const user = await requireUser(req);
    const body = await readJson(req);
    const row = await one(
      `INSERT INTO body_measurements (user_id, height_cm, weight_kg, weight_goal_kg, measured_at)
       VALUES ($1, $2, $3, $4, COALESCE($5::date, CURRENT_DATE))
       RETURNING *`,
      [user.id, body.heightCm || null, body.weightKg || null, body.weightGoalKg || null, body.measuredAt || null]
    );
    return ok(res, { data: camel(row) }, 201);
  }

  if (req.method === "GET" && matchPath(pathname, "/api/favorites")) {
    const user = await requireUser(req);
    const rows = await many(
      "SELECT * FROM exercise_favorites WHERE user_id = $1 ORDER BY created_at DESC",
      [user.id]
    );
    return ok(res, { data: camel(rows) });
  }

  const fav = matchPath(pathname, "/api/favorites/:exerciseId");
  if (req.method === "POST" && fav) {
    const user = await requireUser(req);
    const row = await one(
      `INSERT INTO exercise_favorites (user_id, exercise_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id, exercise_id) DO UPDATE SET created_at = now()
       RETURNING *`,
      [user.id, fav.exerciseId]
    );
    return ok(res, { data: camel(row) }, 201);
  }

  if (req.method === "DELETE" && fav) {
    const user = await requireUser(req);
    await one(
      "DELETE FROM exercise_favorites WHERE user_id = $1 AND exercise_id = $2 RETURNING user_id",
      [user.id, fav.exerciseId]
    );
    return ok(res, { deleted: true });
  }

  if (req.method === "GET" && matchPath(pathname, "/api/feedback")) {
    const user = await requireUser(req);
    const rows = await many("SELECT * FROM exercise_feedback WHERE user_id = $1", [user.id]);
    return ok(res, { data: camel(rows) });
  }

  const fb = matchPath(pathname, "/api/feedback/:exerciseId");
  if ((req.method === "PUT" || req.method === "POST") && fb) {
    const user = await requireUser(req);
    const body = await readJson(req);
    required(body, ["feedback"]);
    if (body.feedback !== "positive" && body.feedback !== "negative") {
      throw httpError(400, "feedback deve ser positive ou negative");
    }
    const row = await one(
      `INSERT INTO exercise_feedback (user_id, exercise_id, feedback)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, exercise_id)
       DO UPDATE SET feedback = EXCLUDED.feedback, updated_at = now()
       RETURNING *`,
      [user.id, fb.exerciseId, body.feedback]
    );
    return ok(res, { data: camel(row) });
  }

  if (req.method === "POST" && matchPath(pathname, "/api/analytics")) {
    const user = await requireUser(req);
    const body = await readJson(req);
    required(body, ["event"]);
    const row = await one(
      `INSERT INTO analytics_events (user_id, event, exercise_id, payload)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [user.id, body.event, body.exerciseId || null, body.payload ? JSON.stringify(body.payload) : null]
    );
    return ok(res, { data: camel(row) }, 201);
  }

  if (req.method === "GET" && matchPath(pathname, "/api/apps")) {
    const user = await requireUser(req);
    const rows = await many("SELECT * FROM connected_apps WHERE user_id = $1", [user.id]);
    return ok(res, { data: camel(rows) });
  }

  const app = matchPath(pathname, "/api/apps/:app");
  if (req.method === "PUT" && app) {
    const user = await requireUser(req);
    const body = await readJson(req);
    if (app.app !== "apple_health" && app.app !== "strava") throw httpError(400, "app inválido");
    const status = body.status || "connected";
    const row = await one(
      `INSERT INTO connected_apps (user_id, app, status, connected_at)
       VALUES ($1, $2, $3, CASE WHEN $3 = 'connected' THEN now() ELSE NULL END)
       ON CONFLICT (user_id, app)
       DO UPDATE SET
         status = EXCLUDED.status,
         connected_at = CASE WHEN EXCLUDED.status = 'connected' THEN now() ELSE connected_apps.connected_at END
       RETURNING *`,
      [user.id, app.app, status]
    );
    return ok(res, { data: camel(row) });
  }

  return false;
}

module.exports = { handle };
