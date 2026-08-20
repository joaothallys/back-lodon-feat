const { one, many, camel, pool } = require("../../db/pool");
const { ok, readJson, matchPath, required, httpError } = require("../../lib/http");
const { requireUser } = require("../../lib/auth");

function normalizeExercises(list) {
  if (!Array.isArray(list)) return [];
  return list.map((item, index) => ({
    position: item.position != null ? Number(item.position) : index,
    exerciseId: item.exerciseId,
    sets: Number(item.sets) || 0,
    reps: Number(item.reps) || 0,
    kg: Number(item.kg) || 0,
    restSec: Number(item.restSec) || 90
  })).filter((item) => item.exerciseId);
}

async function replaceExercises(client, workoutId, exercises) {
  await client.query("DELETE FROM custom_workout_exercises WHERE workout_id = $1", [workoutId]);
  for (const item of normalizeExercises(exercises)) {
    await client.query(
      `INSERT INTO custom_workout_exercises (workout_id, position, exercise_id, sets, reps, kg, rest_sec)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [workoutId, item.position, item.exerciseId, item.sets, item.reps, item.kg, item.restSec]
    );
  }
}

async function loadWorkout(workout) {
  const exercises = await many(
    "SELECT * FROM custom_workout_exercises WHERE workout_id = $1 ORDER BY position ASC",
    [workout.id]
  );
  return { ...camel(workout), exercises: camel(exercises) };
}

async function getOwned(userId, id) {
  const workout = await one(
    "SELECT * FROM custom_workouts WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
    [id, userId]
  );
  if (!workout) throw httpError(404, "ficha não encontrada");
  return workout;
}

async function handle(req, res, url) {
  const pathname = url.pathname;

  if (req.method === "GET" && matchPath(pathname, "/api/workouts")) {
    const user = await requireUser(req);
    const rows = await many(
      "SELECT * FROM custom_workouts WHERE user_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC",
      [user.id]
    );
    const data = [];
    for (const row of rows) data.push(await loadWorkout(row));
    return ok(res, { data });
  }

  if (req.method === "POST" && matchPath(pathname, "/api/workouts")) {
    const user = await requireUser(req);
    const body = await readJson(req);
    required(body, ["name"]);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const workout = (await client.query(
        `INSERT INTO custom_workouts (user_id, name, is_favorite)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [user.id, body.name, Boolean(body.isFavorite)]
      )).rows[0];
      await replaceExercises(client, workout.id, body.exercises || []);
      await client.query("COMMIT");
      return ok(res, { data: await loadWorkout(workout) }, 201);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  const oneW = matchPath(pathname, "/api/workouts/:id");
  if (req.method === "GET" && oneW) {
    const user = await requireUser(req);
    return ok(res, { data: await loadWorkout(await getOwned(user.id, oneW.id)) });
  }

  if (req.method === "PUT" && oneW) {
    const user = await requireUser(req);
    const body = await readJson(req);
    const current = await getOwned(user.id, oneW.id);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const workout = (await client.query(
        `UPDATE custom_workouts SET
           name = COALESCE($1, name),
           is_favorite = COALESCE($2, is_favorite),
           updated_at = now()
         WHERE id = $3
         RETURNING *`,
        [body.name || null, body.isFavorite == null ? null : Boolean(body.isFavorite), current.id]
      )).rows[0];
      if (body.exercises) await replaceExercises(client, workout.id, body.exercises);
      await client.query("COMMIT");
      return ok(res, { data: await loadWorkout(workout) });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  if (req.method === "DELETE" && oneW) {
    const user = await requireUser(req);
    const current = await getOwned(user.id, oneW.id);
    await one(
      "UPDATE custom_workouts SET deleted_at = now(), updated_at = now() WHERE id = $1 RETURNING id",
      [current.id]
    );
    return ok(res, { deleted: true });
  }

  return false;
}

module.exports = { handle };
