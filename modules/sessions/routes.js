const { one, many, camel, pool } = require("../../db/pool");
const { ok, readJson, matchPath, httpError, query } = require("../../lib/http");
const { requireUser } = require("../../lib/auth");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_TYPES = new Set(["plan_day", "custom", "fast", "single"]);
const SET_TYPES = new Set(["W", "N", "D", "S"]);

// Treino esquecido aberto por dias não pode virar 17 mil minutos.
const MAX_DURATION_MIN = 600;

function calcCalories(durationMin, volumeKg) {
  return Math.max(0, Math.round((Number(durationMin) || 0) * 5.5 + (Number(volumeKg) || 0) * 0.035));
}

function asUuid(value) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  return UUID_RE.test(text) ? text : null;
}

function asSourceType(value) {
  const type = String(value || "").trim();
  return SOURCE_TYPES.has(type) ? type : "custom";
}

function asSetType(value) {
  const type = String(value || "N").toUpperCase();
  return SET_TYPES.has(type) ? type : "N";
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
  let doneExercises = 0;
  exercises.forEach((exercise) => {
    let anyDone = false;
    (exercise.sets || []).forEach((set) => {
      if (!set.done) return;
      anyDone = true;
      setsCount += 1;
      if (set.type !== "W") volume += Number(set.kg) * Number(set.reps);
      if (Number(set.kg) > bestWeight) {
        bestWeight = Number(set.kg);
        bestReps = Number(set.reps);
      }
    });
    if (anyDone) doneExercises += 1;
  });
  return { volume, setsCount, doneExercises, bestWeight: bestWeight || null, bestReps: bestReps || null };
}

function sessionFinishStatus(exercises) {
  const working = [];
  (exercises || []).forEach((exercise) => {
    (exercise.sets || []).forEach((set) => {
      if (set.type !== "W") working.push(set);
    });
  });
  if (!working.length) return "completed";
  const done = working.filter((set) => set.done);
  if (!done.length || done.length === working.length) return "completed";
  return "partial";
}

function normalizeExercises(exercises) {
  return (exercises || []).map((exercise, index) => {
    const sets = Array.isArray(exercise.sets)
      ? exercise.sets.map((set, setIndex) => ({
        type: asSetType(set.type),
        kg: Number(set.kg) || 0,
        reps: Number(set.reps) || 0,
        done: Boolean(set.done),
        position: set.position != null ? set.position : setIndex
      }))
      : [];
    return {
      exerciseId: exercise.exerciseId ? String(exercise.exerciseId) : "",
      restSec: exercise.restSec != null ? exercise.restSec : 90,
      replacedFromExerciseId: exercise.replacedFromExerciseId || null,
      position: exercise.position != null ? exercise.position : index,
      sets
    };
  }).filter((exercise) => exercise.exerciseId);
}

function templateToExercises(exercises) {
  return (exercises || []).map((exercise) => {
    if (Array.isArray(exercise.sets) && exercise.sets.length) return exercise;
    const count = Number(exercise.setsCount || exercise.sets) || 3;
    return {
      ...exercise,
      sets: Array.from({ length: count }, () => ({
        type: "N",
        kg: Number(exercise.kg) || 0,
        reps: Number(exercise.reps) || 10,
        done: false
      }))
    };
  });
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
    const sets = Array.isArray(exercise.sets) ? exercise.sets : [];
    for (const [setIndex, set] of sets.entries()) {
      await client.query(
        `INSERT INTO workout_sets (session_exercise_id, position, type, kg, reps, done, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          created.id,
          set.position != null ? set.position : setIndex,
          asSetType(set.type),
          Number(set.kg) || 0,
          Number(set.reps) || 0,
          Boolean(set.done),
          set.done ? new Date() : null
        ]
      );
    }
  }
}

async function replaceSessionTree(client, sessionId, exercises) {
  await client.query("DELETE FROM workout_session_exercises WHERE session_id = $1", [sessionId]);
  await insertSessionExercises(client, sessionId, exercises);
}

async function copyFromSource(userId, sourceType, sourceId) {
  sourceId = asUuid(sourceId);
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

function lastWorkingSet(exercise) {
  const sets = (exercise.sets || []).filter((set) => set.type !== "W");
  const last = sets[sets.length - 1] || (exercise.sets || [])[0] || {};
  return {
    exerciseId: exercise.exerciseId,
    sets: Math.max(1, (exercise.sets || []).filter((set) => set.type !== "W").length || 3),
    reps: Number(last.reps) || 10,
    kg: Number(last.kg) || 0,
    restSec: exercise.restSec != null ? exercise.restSec : 90
  };
}

async function saveAsCustomWorkout(userId, name, exercises) {
  const items = (exercises || [])
    .filter((exercise) => (exercise.sets || []).some((set) => set.done && set.type !== "W"))
    .map(lastWorkingSet)
    .filter((item) => item.exerciseId);
  if (!items.length) return null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const workout = (await client.query(
      `INSERT INTO custom_workouts (user_id, name, is_favorite)
       VALUES ($1, $2, false)
       RETURNING *`,
      [userId, name || "Treino salvo"]
    )).rows[0];
    for (const [index, item] of items.entries()) {
      await client.query(
        `INSERT INTO custom_workout_exercises (workout_id, position, exercise_id, sets, reps, kg, rest_sec)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [workout.id, index, item.exerciseId, item.sets, item.reps, item.kg, item.restSec]
      );
    }
    await client.query("COMMIT");
    return workout;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function finishSession(user, session, body) {
  if ((session.status === "completed" || session.status === "partial") && session.deleted_at == null) {
    return loadSession(session);
  }
  if (session.status === "abandoned") throw httpError(409, "sessão abandonada");

  if (body.exercises !== undefined) {
    const exercises = normalizeExercises(body.exercises);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await replaceSessionTree(client, session.id, exercises);
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
  const duration = Math.min(MAX_DURATION_MIN, body.durationMin != null
    ? Math.max(0, Number(body.durationMin) || 0)
    : Math.max(0, Math.round((Date.now() - new Date(session.started_at).getTime()) / 60000)));
  const calories = body.calories != null ? Number(body.calories) : calcCalories(duration, stats.volume);
  const status = sessionFinishStatus(loaded.exercises);
  const updated = await one(
    `UPDATE workout_sessions SET
       status = $1,
       finished_at = now(),
       duration_min = $2,
       volume_kg = $3,
       calories = $4,
       exercises_count = $5,
       sets_count = $6,
       best_weight = $7,
       best_reps = $8,
       name = COALESCE($9, name)
     WHERE id = $10
     RETURNING *`,
    [
      status,
      duration,
      stats.volume,
      calories,
      stats.doneExercises,
      stats.setsCount,
      stats.bestWeight,
      stats.bestReps,
      body.name || null,
      session.id
    ]
  );
  await touchRecovery(user.id, body.muscles);
  const saved = await loadSession(updated);
  let workout = null;
  if (body.saveAsWorkout) {
    workout = await saveAsCustomWorkout(user.id, body.name || updated.name, saved.exercises);
  }
  return workout ? { ...saved, savedWorkoutId: workout.id } : saved;
}

async function createCompletedSession(user, body) {
  const sourceType = asSourceType(body.sourceType);
  const sourceId = asUuid(body.sourceId);
  const copied = await copyFromSource(user.id, sourceType, sourceId);
  const name = body.name || (copied && copied.name) || "Treino";
  const exercises = normalizeExercises(
    Array.isArray(body.exercises) ? body.exercises : ((copied && copied.exercises) || [])
  );

  const stats = totalsFromSets(exercises);
  const duration = body.durationMin != null ? Math.min(MAX_DURATION_MIN, Math.max(0, Number(body.durationMin) || 0)) : 0;
  const calories = body.calories != null ? Number(body.calories) : calcCalories(duration, stats.volume);
  const startedAt = body.startedAt || new Date(Date.now() - duration * 60000);
  const status = sessionFinishStatus(exercises);

  const client = await pool.connect();
  let session;
  try {
    await client.query("BEGIN");
    session = (await client.query(
      `INSERT INTO workout_sessions (
         user_id, source_type, source_id, name, status, started_at, finished_at,
         duration_min, volume_kg, calories, exercises_count, sets_count, best_weight, best_reps
       ) VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        user.id,
        sourceType,
        sourceId,
        name,
        status,
        startedAt,
        duration,
        stats.volume,
        calories,
        stats.doneExercises,
        stats.setsCount,
        stats.bestWeight,
        stats.bestReps
      ]
    )).rows[0];
    await insertSessionExercises(client, session.id, exercises);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  await touchRecovery(user.id, body.muscles);
  const saved = await loadSession(session);
  if (body.saveAsWorkout) {
    const workout = await saveAsCustomWorkout(user.id, name, saved.exercises);
    if (workout) saved.savedWorkoutId = workout.id;
  }
  return saved;
}

function historyStatuses(status) {
  if (status === "partial") return ["partial"];
  if (status === "in_progress" || status === "abandoned") return [status];
  return ["completed", "partial"];
}

async function listHistory(userId, status) {
  const statuses = historyStatuses(status);
  const rows = await many(
    `SELECT * FROM workout_sessions
     WHERE user_id = $1 AND deleted_at IS NULL AND status = ANY($2::text[])
     ORDER BY COALESCE(finished_at, started_at) DESC
     LIMIT 50`,
    [userId, statuses]
  );
  const data = [];
  for (const row of rows) data.push(await loadSession(row));
  return data;
}

async function handle(req, res, url) {
  const pathname = url.pathname;
  const q = query(url);

  if (req.method === "GET" && (matchPath(pathname, "/api/history") || matchPath(pathname, "/api/sessions"))) {
    const user = await requireUser(req);
    return ok(res, { data: await listHistory(user.id, q.status || "completed") });
  }

  if (req.method === "GET" && matchPath(pathname, "/api/sessions/current")) {
    const user = await requireUser(req);
    const session = await one(
      "SELECT * FROM workout_sessions WHERE user_id = $1 AND status = 'in_progress' AND deleted_at IS NULL LIMIT 1",
      [user.id]
    );
    return ok(res, { data: session ? await loadSession(session) : null });
  }

  if (req.method === "POST" && matchPath(pathname, "/api/sessions/complete")) {
    const user = await requireUser(req);
    const body = await readJson(req);
    if (body.sessionId) {
      const session = await one(
        "SELECT * FROM workout_sessions WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
        [body.sessionId, user.id]
      );
      if (!session) throw httpError(404, "sessão não encontrada");
      return ok(res, { data: await finishSession(user, session, body) });
    }
    const current = await one(
      "SELECT * FROM workout_sessions WHERE user_id = $1 AND status = 'in_progress' AND deleted_at IS NULL LIMIT 1",
      [user.id]
    );
    if (current) return ok(res, { data: await finishSession(user, current, body) });
    return ok(res, { data: await createCompletedSession(user, body) });
  }

  if (req.method === "POST" && matchPath(pathname, "/api/sessions")) {
    const user = await requireUser(req);
    const body = await readJson(req);
    const existing = await one(
      "SELECT * FROM workout_sessions WHERE user_id = $1 AND status = 'in_progress' AND deleted_at IS NULL LIMIT 1",
      [user.id]
    );
    if (existing) return ok(res, { data: await loadSession(existing), resumed: true });

    const sourceType = asSourceType(body.sourceType);
    const sourceId = asUuid(body.sourceId);
    const copied = await copyFromSource(user.id, sourceType, sourceId);
    const name = body.name || (copied && copied.name) || "Treino";
    const exercises = templateToExercises(body.exercises || (copied && copied.exercises) || []);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const session = (await client.query(
        `INSERT INTO workout_sessions (user_id, source_type, source_id, name, status, exercises_count)
         VALUES ($1, $2, $3, $4, 'in_progress', $5)
         RETURNING *`,
        [user.id, sourceType, sourceId, name, exercises.length]
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
    return ok(res, { data: await finishSession(user, session, body) });
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

  const historyOne = matchPath(pathname, "/api/history/:id");
  const oneS = matchPath(pathname, "/api/sessions/:id");
  if (req.method === "GET" && (historyOne || oneS)) {
    const user = await requireUser(req);
    const id = (historyOne || oneS).id;
    const session = await one(
      "SELECT * FROM workout_sessions WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
      [id, user.id]
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
    if (body.exercises !== undefined) {
      const exercises = normalizeExercises(body.exercises);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await replaceSessionTree(client, session.id, exercises);
        await client.query(
          "UPDATE workout_sessions SET exercises_count = $1 WHERE id = $2",
          [exercises.length, session.id]
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
