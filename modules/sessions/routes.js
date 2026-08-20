const { one, many, camel, pool } = require("../../db/pool");
const { ok, readJson, matchPath, required, httpError, query } = require("../../lib/http");
const { requireUser } = require("../../lib/auth");

function calcCalories(durationMin, volumeKg) {
  return Math.max(0, Math.round((Number(durationMin) || 0) * 5.5 + (Number(volumeKg) || 0) * 0.035));
}

async function loadSession(session) {
  const exercises = await many(
    "SELECT * FROM workout_session_exercises WHERE session_id = $1 ORDER BY position ASC",
    [session.id]
  );
  const out = [];
  for (const exercise of exercises) {
    const sets = await many(
      "SELECT * FROM workout_sets WHERE session_exercise_id = $1 ORDER BY position ASC",
      [exercise.id]
    );
    out.push({ ...camel(exercise), sets: camel(sets) });
  }
  return { ...camel(session), exercises: out };
}

function totalsFromSets(exercises) {
  let volume = 0;
  let setsCount = 0;
  let bestWeight = 0;
  let bestReps = 0;
  exercises.forEach((exercise) => {
    (exercise.sets || []).forEach((set) => {
      if (!set.done) return;
      setsCount += 1;
      if (set.type !== "W") volume += Number(set.kg) * Number(set.reps);
      if (Number(set.kg) > bestWeight) {
        bestWeight = Number(set.kg);
        bestReps = Number(set.reps);
      }
    });
  });
  return { volume, setsCount, bestWeight: bestWeight || null, bestReps: bestReps || null };
}

async function insertSessionExercises(client, sessionId, exercises) {
  for (const [index, exercise] of (exercises || []).entries()) {
    if (!exercise.exerciseId) continue;
    const created = (await client.query(
      `INSERT INTO workout_session_exercises (session_id, position, exercise_id, rest_sec, replaced_from_exercise_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        sessionId,
        exercise.position != null ? exercise.position : index,
        exercise.exerciseId,
        exercise.restSec != null ? exercise.restSec : 90,
        exercise.replacedFromExerciseId || null
      ]
    )).rows[0];
    const sets = Array.isArray(exercise.sets) && exercise.sets.length
      ? exercise.sets
      : Array.from({ length: Number(exercise.setsCount) || 3 }, () => ({
        type: "N",
        kg: Number(exercise.kg) || 0,
        reps: Number(exercise.reps) || 10,
        done: false
      }));
    for (const [setIndex, set] of sets.entries()) {
      await client.query(
        `INSERT INTO workout_sets (session_exercise_id, position, type, kg, reps, done, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          created.id,
          set.position != null ? set.position : setIndex,
          set.type || "N",
          Number(set.kg) || 0,
          Number(set.reps) || 0,
          Boolean(set.done),
          set.done ? new Date() : null
        ]
      );
    }
  }
}

async function copyFromSource(userId, sourceType, sourceId) {
  if (sourceType === "custom" && sourceId) {
    const workout = await one(
      "SELECT * FROM custom_workouts WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
      [sourceId, userId]
    );
    if (!workout) throw httpError(404, "ficha não encontrada");
    const exercises = await many(
      "SELECT * FROM custom_workout_exercises WHERE workout_id = $1 ORDER BY position",
      [workout.id]
    );
    return {
      name: workout.name,
      exercises: exercises.map((row) => ({
        exerciseId: row.exercise_id,
        restSec: row.rest_sec,
        kg: row.kg,
        reps: row.reps,
        setsCount: row.sets
      }))
    };
  }
  if (sourceType === "plan_day" && sourceId) {
    const day = await one(
      `SELECT d.*, p.user_id
       FROM workout_plan_days d
       JOIN workout_plans p ON p.id = d.plan_id
       WHERE d.id = $1 AND p.user_id = $2`,
      [sourceId, userId]
    );
    if (!day) throw httpError(404, "dia do plano não encontrado");
    const exercises = await many(
      "SELECT * FROM workout_plan_exercises WHERE day_id = $1 ORDER BY position",
      [day.id]
    );
    return {
      name: day.name,
      exercises: exercises.map((row) => ({
        exerciseId: row.exercise_id,
        restSec: row.rest_sec,
        kg: row.kg,
        reps: row.reps,
        setsCount: row.sets
      }))
    };
  }
  return null;
}

async function replaceSessionTree(client, sessionId, exercises) {
  await client.query("DELETE FROM workout_session_exercises WHERE session_id = $1", [sessionId]);
  await insertSessionExercises(client, sessionId, exercises);
}

async function touchRecovery(userId, muscles) {
  const items = Array.isArray(muscles) ? muscles : [];
  for (const muscle of items) {
    await one(
      `INSERT INTO muscle_recovery (user_id, muscle_id, last_trained_at)
       VALUES ($1, $2, now())
       ON CONFLICT (user_id, muscle_id)
       DO UPDATE SET last_trained_at = now()
       RETURNING user_id`,
      [userId, String(muscle)]
    );
  }
}

async function handle(req, res, url) {
  const pathname = url.pathname;
  const q = query(url);

  if (req.method === "GET" && matchPath(pathname, "/api/sessions/current")) {
    const user = await requireUser(req);
    const session = await one(
      "SELECT * FROM workout_sessions WHERE user_id = $1 AND status = 'in_progress' AND deleted_at IS NULL LIMIT 1",
      [user.id]
    );
    return ok(res, { data: session ? await loadSession(session) : null });
  }

  if (req.method === "GET" && matchPath(pathname, "/api/sessions")) {
    const user = await requireUser(req);
    const status = q.status || "completed";
    const rows = await many(
      `SELECT * FROM workout_sessions
       WHERE user_id = $1 AND deleted_at IS NULL AND status = $2
       ORDER BY started_at DESC
       LIMIT 50`,
      [user.id, status]
    );
    const data = [];
    for (const row of rows) data.push(await loadSession(row));
    return ok(res, { data });
  }

  if (req.method === "POST" && matchPath(pathname, "/api/sessions")) {
    const user = await requireUser(req);
    const body = await readJson(req);
    const existing = await one(
      "SELECT * FROM workout_sessions WHERE user_id = $1 AND status = 'in_progress' AND deleted_at IS NULL LIMIT 1",
      [user.id]
    );
    if (existing) return ok(res, { data: await loadSession(existing), resumed: true });

    const sourceType = body.sourceType || "fast";
    const copied = await copyFromSource(user.id, sourceType, body.sourceId);
    const name = body.name || (copied && copied.name) || "Treino";
    const exercises = body.exercises || (copied && copied.exercises) || [];

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const session = (await client.query(
        `INSERT INTO workout_sessions (user_id, source_type, source_id, name, status, exercises_count)
         VALUES ($1, $2, $3, $4, 'in_progress', $5)
         RETURNING *`,
        [user.id, sourceType, body.sourceId || null, name, exercises.length]
      )).rows[0];
      await insertSessionExercises(client, session.id, exercises);
      await client.query("COMMIT");
      return ok(res, { data: await loadSession(session) }, 201);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  const complete = matchPath(pathname, "/api/sessions/:id/complete");
  if (req.method === "POST" && complete) {
    const user = await requireUser(req);
    const body = await readJson(req);
    const session = await one(
      "SELECT * FROM workout_sessions WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
      [complete.id, user.id]
    );
    if (!session) throw httpError(404, "sessão não encontrada");
    if (body.exercises) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await replaceSessionTree(client, session.id, body.exercises);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }
    const loaded = await loadSession(session);
    const stats = totalsFromSets(loaded.exercises);
    const duration = body.durationMin != null
      ? Number(body.durationMin)
      : Math.max(1, Math.round((Date.now() - new Date(session.started_at).getTime()) / 60000));
    const calories = body.calories != null ? Number(body.calories) : calcCalories(duration, stats.volume);
    const updated = await one(
      `UPDATE workout_sessions SET
         status = 'completed',
         finished_at = now(),
         duration_min = $1,
         volume_kg = $2,
         calories = $3,
         exercises_count = $4,
         sets_count = $5,
         best_weight = $6,
         best_reps = $7
       WHERE id = $8
       RETURNING *`,
      [duration, stats.volume, calories, loaded.exercises.length, stats.setsCount, stats.bestWeight, stats.bestReps, session.id]
    );
    await touchRecovery(user.id, body.muscles);
    return ok(res, { data: await loadSession(updated) });
  }

  const abandon = matchPath(pathname, "/api/sessions/:id/abandon");
  if (req.method === "POST" && abandon) {
    const user = await requireUser(req);
    const session = await one(
      `UPDATE workout_sessions
       SET status = 'abandoned', finished_at = now(), deleted_at = now()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING *`,
      [abandon.id, user.id]
    );
    if (!session) throw httpError(404, "sessão não encontrada");
    return ok(res, { data: camel(session) });
  }

  const oneS = matchPath(pathname, "/api/sessions/:id");
  if (req.method === "GET" && oneS) {
    const user = await requireUser(req);
    const session = await one(
      "SELECT * FROM workout_sessions WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
      [oneS.id, user.id]
    );
    if (!session) throw httpError(404, "sessão não encontrada");
    return ok(res, { data: await loadSession(session) });
  }

  if (req.method === "PUT" && oneS) {
    const user = await requireUser(req);
    const body = await readJson(req);
    const session = await one(
      "SELECT * FROM workout_sessions WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
      [oneS.id, user.id]
    );
    if (!session) throw httpError(404, "sessão não encontrada");
    if (session.status !== "in_progress") throw httpError(409, "sessão já encerrada");
    if (body.exercises) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await replaceSessionTree(client, session.id, body.exercises);
        await client.query(
          "UPDATE workout_sessions SET exercises_count = $1 WHERE id = $2",
          [body.exercises.length, session.id]
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }
    const fresh = await one("SELECT * FROM workout_sessions WHERE id = $1", [session.id]);
    return ok(res, { data: await loadSession(fresh) });
  }

  return false;
}

module.exports = { handle };
