const { one, many, camel, pool } = require("../../db/pool");
const { ok, readJson, matchPath, httpError, query } = require("../../lib/http");
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

function asDoneOnComplete(exercises, completing) {
  return (exercises || []).map((exercise, index) => ({
    ...exercise,
    position: exercise.position != null ? exercise.position : index,
    sets: (exercise.sets || []).map((set, setIndex) => ({
      ...set,
      position: set.position != null ? set.position : setIndex,
      done: completing ? set.done !== false : Boolean(set.done)
    }))
  }));
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

async function replaceSessionTree(client, sessionId, exercises) {
  await client.query("DELETE FROM workout_session_exercises WHERE session_id = $1", [sessionId]);
  await insertSessionExercises(client, sessionId, exercises);
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
  const items = (exercises || []).map(lastWorkingSet).filter((item) => item.exerciseId);
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
  if (session.status === "completed" && session.deleted_at == null) {
    return loadSession(session);
  }
  if (session.status === "abandoned") throw httpError(409, "sessão abandonada");

  if (body.exercises) {
    const exercises = asDoneOnComplete(templateToExercises(body.exercises), true);
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
  } else {
    const current = await loadSession(session);
    if (current.exercises.length) {
      const exercises = asDoneOnComplete(current.exercises, true);
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
       best_reps = $7,
       name = COALESCE($8, name)
     WHERE id = $9
     RETURNING *`,
    [
      duration,
      stats.volume,
      calories,
      loaded.exercises.length,
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
  const sourceType = body.sourceType || "fast";
  const copied = await copyFromSource(user.id, sourceType, body.sourceId);
  const name = body.name || (copied && copied.name) || "Treino";
  const raw = body.exercises || (copied && copied.exercises) || [];
  const exercises = asDoneOnComplete(templateToExercises(raw), true);
  if (!exercises.length) throw httpError(400, "envie os exercícios do treino finalizado");

  const stats = totalsFromSets(exercises);
  const duration = body.durationMin != null ? Number(body.durationMin) : 1;
  const calories = body.calories != null ? Number(body.calories) : calcCalories(duration, stats.volume);
  const startedAt = body.startedAt || new Date(Date.now() - duration * 60000);

  const client = await pool.connect();
  let session;
  try {
    await client.query("BEGIN");
    session = (await client.query(
      `INSERT INTO workout_sessions (
         user_id, source_type, source_id, name, status, started_at, finished_at,
         duration_min, volume_kg, calories, exercises_count, sets_count, best_weight, best_reps
       ) VALUES ($1, $2, $3, $4, 'completed', $5, now(), $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        user.id,
        sourceType,
        body.sourceId || null,
        name,
        startedAt,
        duration,
        stats.volume,
        calories,
        exercises.length,
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

async function listHistory(userId, status) {
  const rows = await many(
    `SELECT * FROM workout_sessions
     WHERE user_id = $1 AND deleted_at IS NULL AND status = $2
     ORDER BY COALESCE(finished_at, started_at) DESC
     LIMIT 50`,
    [userId, status]
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
    return ok(res, { data: await createCompletedSession(user, body) }, 201);
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
    const exercises = templateToExercises(body.exercises || (copied && copied.exercises) || []);

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
    if (body.exercises) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await replaceSessionTree(client, session.id, templateToExercises(body.exercises));
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
