const { one, many, camel, pool } = require("../../db/pool");
const { ok, readJson, matchPath, required, httpError } = require("../../lib/http");
const { requireUser } = require("../../lib/auth");

const TEMPLATES = {
  3: [
    { name: "A · Superiores", focus: ["peito", "costas", "ombros", "bracos"] },
    { name: "B · Inferiores", focus: ["pernas"] },
    { name: "C · Full body", focus: ["peito", "costas", "pernas"] }
  ],
  4: [
    { name: "A · Peito e tríceps", focus: ["peito", "triceps"] },
    { name: "B · Costas e bíceps", focus: ["costas", "biceps"] },
    { name: "C · Pernas", focus: ["pernas"] },
    { name: "D · Ombros e core", focus: ["ombros"] }
  ],
  5: [
    { name: "A · Peito", focus: ["peito"] },
    { name: "B · Costas", focus: ["costas"] },
    { name: "C · Pernas", focus: ["pernas"] },
    { name: "D · Ombros", focus: ["ombros"] },
    { name: "E · Braços", focus: ["biceps", "triceps"] }
  ],
  6: [
    { name: "A · Peito", focus: ["peito"] },
    { name: "B · Costas", focus: ["costas"] },
    { name: "C · Ombros", focus: ["ombros"] },
    { name: "D · Pernas", focus: ["pernas"] },
    { name: "E · Braços", focus: ["biceps", "triceps"] },
    { name: "F · Core e cardio", focus: ["abdomen"] }
  ]
};

function normalizeExercises(list) {
  if (!Array.isArray(list)) return [];
  return list.map((item, index) => ({
    position: item.position != null ? Number(item.position) : index,
    exerciseId: item.exerciseId,
    sets: Number(item.sets) || 3,
    reps: Number(item.reps) || 10,
    kg: Number(item.kg) || 0,
    restSec: Number(item.restSec) || 90
  })).filter((item) => item.exerciseId);
}

async function insertDays(client, planId, days) {
  for (const [index, day] of days.entries()) {
    const created = (await client.query(
      `INSERT INTO workout_plan_days (plan_id, position, name)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [planId, day.position != null ? day.position : index, day.name || ("Dia " + (index + 1))]
    )).rows[0];
    for (const muscle of day.focus || []) {
      await client.query(
        "INSERT INTO workout_plan_day_focus (day_id, muscle_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [created.id, String(muscle)]
      );
    }
    for (const item of normalizeExercises(day.exercises || [])) {
      await client.query(
        `INSERT INTO workout_plan_exercises (day_id, position, exercise_id, sets, reps, kg, rest_sec)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [created.id, item.position, item.exerciseId, item.sets, item.reps, item.kg, item.restSec]
      );
    }
  }
}

async function loadPlan(plan) {
  const days = await many(
    "SELECT * FROM workout_plan_days WHERE plan_id = $1 ORDER BY position ASC",
    [plan.id]
  );
  const out = [];
  for (const day of days) {
    const focus = await many("SELECT muscle_id FROM workout_plan_day_focus WHERE day_id = $1", [day.id]);
    const exercises = await many(
      "SELECT * FROM workout_plan_exercises WHERE day_id = $1 ORDER BY position ASC",
      [day.id]
    );
    out.push({
      ...camel(day),
      focus: focus.map((row) => row.muscle_id),
      exercises: camel(exercises)
    });
  }
  return { ...camel(plan), days: out };
}

async function deactivateOthers(client, userId, keepId) {
  await client.query(
    "UPDATE workout_plans SET is_active = false, updated_at = now() WHERE user_id = $1 AND id <> $2 AND is_active = true",
    [userId, keepId]
  );
}

async function handle(req, res, url) {
  const pathname = url.pathname;

  if (req.method === "GET" && matchPath(pathname, "/api/plans/active")) {
    const user = await requireUser(req);
    const plan = await one(
      "SELECT * FROM workout_plans WHERE user_id = $1 AND is_active = true LIMIT 1",
      [user.id]
    );
    return ok(res, { data: plan ? await loadPlan(plan) : null });
  }

  if (req.method === "PUT" && matchPath(pathname, "/api/plans/active")) {
    const user = await requireUser(req);
    const body = await readJson(req);
    required(body, ["planId"]);
    const plan = await one(
      "SELECT * FROM workout_plans WHERE id = $1 AND user_id = $2",
      [body.planId, user.id]
    );
    if (!plan) throw httpError(404, "plano não encontrado");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await deactivateOthers(client, user.id, plan.id);
      const updated = (await client.query(
        "UPDATE workout_plans SET is_active = true, updated_at = now() WHERE id = $1 RETURNING *",
        [plan.id]
      )).rows[0];
      await client.query("COMMIT");
      return ok(res, { data: await loadPlan(updated) });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  if (req.method === "GET" && matchPath(pathname, "/api/plans")) {
    const user = await requireUser(req);
    const rows = await many(
      "SELECT * FROM workout_plans WHERE user_id = $1 ORDER BY is_active DESC, updated_at DESC",
      [user.id]
    );
    const data = [];
    for (const row of rows) data.push(await loadPlan(row));
    return ok(res, { data });
  }

  if (req.method === "POST" && matchPath(pathname, "/api/plans/generate")) {
    const user = await requireUser(req);
    const body = await readJson(req);
    const daysPerWeek = Number(body.daysPerWeek) || 4;
    const days = Array.isArray(body.days) && body.days.length
      ? body.days
      : (TEMPLATES[daysPerWeek] || TEMPLATES[4]);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE workout_plans SET is_active = false, updated_at = now() WHERE user_id = $1 AND is_active = true",
        [user.id]
      );
      const plan = (await client.query(
        `INSERT INTO workout_plans
           (user_id, name, source, program_id, goal, level, days_per_week, is_active, generated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true, now())
         RETURNING *`,
        [
          user.id,
          body.name || "Plano " + daysPerWeek + "x",
          body.source || "ia",
          body.programId || null,
          body.goal || null,
          body.level || null,
          daysPerWeek
        ]
      )).rows[0];
      await insertDays(client, plan.id, days);
      await client.query("COMMIT");
      return ok(res, { data: await loadPlan(plan) }, 201);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  const oneP = matchPath(pathname, "/api/plans/:id");
  if (req.method === "GET" && oneP) {
    const user = await requireUser(req);
    const plan = await one("SELECT * FROM workout_plans WHERE id = $1 AND user_id = $2", [oneP.id, user.id]);
    if (!plan) throw httpError(404, "plano não encontrado");
    return ok(res, { data: await loadPlan(plan) });
  }

  if (req.method === "PUT" && oneP) {
    const user = await requireUser(req);
    const body = await readJson(req);
    const plan = await one("SELECT * FROM workout_plans WHERE id = $1 AND user_id = $2", [oneP.id, user.id]);
    if (!plan) throw httpError(404, "plano não encontrado");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const updated = (await client.query(
        `UPDATE workout_plans SET
           name = COALESCE($1, name),
           source = COALESCE($2, source),
           program_id = COALESCE($3, program_id),
           goal = COALESCE($4, goal),
           level = COALESCE($5, level),
           days_per_week = COALESCE($6, days_per_week),
           updated_at = now()
         WHERE id = $7
         RETURNING *`,
        [body.name || null, body.source || null, body.programId || null, body.goal || null, body.level || null, body.daysPerWeek || null, plan.id]
      )).rows[0];
      if (body.days) {
        await client.query("DELETE FROM workout_plan_days WHERE plan_id = $1", [plan.id]);
        await insertDays(client, plan.id, body.days);
      }
      await client.query("COMMIT");
      return ok(res, { data: await loadPlan(updated) });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  if (req.method === "DELETE" && oneP) {
    const user = await requireUser(req);
    const deleted = await one(
      "DELETE FROM workout_plans WHERE id = $1 AND user_id = $2 RETURNING id",
      [oneP.id, user.id]
    );
    if (!deleted) throw httpError(404, "plano não encontrado");
    return ok(res, { deleted: true });
  }

  return false;
}

module.exports = { handle };
