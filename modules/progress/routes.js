const { one, many } = require("../../db/pool");
const { ok, matchPath, query, httpError } = require("../../lib/http");
const { requireUser } = require("../../lib/auth");
const { muscleFromExerciseId, displayNameFromExerciseId } = require("./muscles");

const TZ = "America/Sao_Paulo";
const RANGES = ["week", "month", "year", "all"];

function sessionFilter(alias) {
  return `${alias}.user_id = $1
    AND ${alias}.status = 'completed'
    AND ${alias}.deleted_at IS NULL`;
}

function rangeSql(alias, range) {
  const col = `${alias}.finished_at`;
  if (range === "week") {
    return `${col} >= date_trunc('week', timezone('${TZ}', now())) AT TIME ZONE '${TZ}'`;
  }
  if (range === "month") {
    return `${col} >= date_trunc('month', timezone('${TZ}', now())) AT TIME ZONE '${TZ}'`;
  }
  if (range === "year") {
    return `${col} >= date_trunc('year', timezone('${TZ}', now())) AT TIME ZONE '${TZ}'`;
  }
  return "TRUE";
}

function parseRange(value) {
  const range = String(value || "week");
  if (!RANGES.includes(range)) throw httpError(400, "range deve ser week, month, year ou all");
  return range;
}

function asDate(value) {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function todayInSaoPaulo() {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
}

function addDays(iso, days) {
  const date = new Date(iso + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function streakFromDates(isoDates) {
  const set = new Set(isoDates.map(asDate).filter(Boolean));
  if (!set.size) return 0;
  const today = todayInSaoPaulo();
  let cursor = set.has(today) ? today : addDays(today, -1);
  if (!set.has(cursor)) return 0;
  let count = 0;
  while (set.has(cursor)) {
    count += 1;
    cursor = addDays(cursor, -1);
  }
  return count;
}

async function loadWorkingSets(userId, range) {
  return many(
    `SELECT
        se.exercise_id,
        s.id AS session_id,
        s.finished_at,
        ws.kg,
        ws.reps,
        (ws.kg * ws.reps) AS volume,
        (s.finished_at AT TIME ZONE '${TZ}')::date AS day
     FROM workout_sets ws
     JOIN workout_session_exercises se ON se.id = ws.session_exercise_id
     JOIN workout_sessions s ON s.id = se.session_id
     WHERE ${sessionFilter("s")}
       AND ${rangeSql("s", range)}
       AND ws.done = true
       AND ws.type <> 'W'`,
    [userId]
  );
}

async function progressOverview(user, range) {
  const summary = await one(
    `SELECT
        COUNT(*)::int AS workouts,
        COALESCE(SUM(duration_min), 0)::int AS duration_min,
        COALESCE(SUM(volume_kg), 0) AS volume_kg,
        COALESCE(SUM(calories), 0)::int AS calories,
        COALESCE(SUM(sets_count), 0)::int AS sets_count
     FROM workout_sessions s
     WHERE ${sessionFilter("s")} AND ${rangeSql("s", range)}`,
    [user.id]
  );

  const calendarRows = await many(
    `SELECT
        (s.finished_at AT TIME ZONE '${TZ}')::date AS day,
        ARRAY_AGG(s.id ORDER BY s.finished_at) AS session_ids,
        COALESCE(SUM(s.volume_kg), 0) AS volume_kg
     FROM workout_sessions s
     WHERE ${sessionFilter("s")} AND ${rangeSql("s", range)}
     GROUP BY 1
     ORDER BY 1 ASC`,
    [user.id]
  );

  const bucketExpr = range === "all"
    ? `to_char(date_trunc('month', s.finished_at AT TIME ZONE '${TZ}'), 'YYYY-MM')`
    : range === "year"
      ? `to_char(date_trunc('week', s.finished_at AT TIME ZONE '${TZ}'), 'YYYY-MM-DD')`
      : `to_char((s.finished_at AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD')`;

  const seriesRows = await many(
    `SELECT
        ${bucketExpr} AS bucket,
        COALESCE(SUM(s.volume_kg), 0) AS volume_kg,
        COALESCE(SUM(s.duration_min), 0)::int AS duration_min,
        COUNT(*)::int AS workouts
     FROM workout_sessions s
     WHERE ${sessionFilter("s")} AND ${rangeSql("s", range)}
     GROUP BY 1
     ORDER BY 1 ASC`,
    [user.id]
  );

  const topRows = await many(
    `SELECT id, name, finished_at, volume_kg, duration_min
     FROM workout_sessions s
     WHERE ${sessionFilter("s")} AND ${rangeSql("s", range)}
     ORDER BY volume_kg DESC, finished_at DESC
     LIMIT 8`,
    [user.id]
  );

  const streakRows = await many(
    `SELECT DISTINCT (finished_at AT TIME ZONE '${TZ}')::date AS day
     FROM workout_sessions s
     WHERE ${sessionFilter("s")}
     ORDER BY 1 DESC
     LIMIT 400`,
    [user.id]
  );

  const weekDone = await one(
    `SELECT COUNT(*)::int AS n
     FROM workout_sessions s
     WHERE ${sessionFilter("s")} AND ${rangeSql("s", "week")}`,
    [user.id]
  );

  const profile = await one(
    "SELECT training_days FROM user_profiles WHERE user_id = $1",
    [user.id]
  );

  return {
    summary: {
      workouts: summary.workouts || 0,
      durationMin: summary.duration_min || 0,
      volumeKg: Number(summary.volume_kg || 0),
      calories: summary.calories || 0,
      setsCount: summary.sets_count || 0
    },
    streakDays: streakFromDates(streakRows.map((row) => row.day)),
    weeklyGoal: {
      done: weekDone.n || 0,
      goal: profile && profile.training_days ? Number(profile.training_days) : 4
    },
    calendar: calendarRows.map((row) => ({
      date: asDate(row.day),
      sessionIds: row.session_ids || [],
      volumeKg: Number(row.volume_kg || 0)
    })),
    series: seriesRows.map((row) => ({
      bucket: row.bucket,
      volumeKg: Number(row.volume_kg || 0),
      durationMin: row.duration_min || 0,
      workouts: row.workouts || 0
    })),
    topSessions: topRows.map((row) => ({
      id: row.id,
      name: row.name,
      finishedAt: row.finished_at,
      volumeKg: Number(row.volume_kg || 0),
      durationMin: row.duration_min || 0
    }))
  };
}

async function progressExercises(userId, range) {
  const sets = await loadWorkingSets(userId, range);
  const byExercise = new Map();
  sets.forEach((row) => {
    const id = row.exercise_id;
    if (!id) return;
    const current = byExercise.get(id) || {
      exerciseId: id,
      displayName: displayNameFromExerciseId(id),
      lastKg: 0,
      lastReps: 0,
      lastAt: null,
      bestKg: 0,
      bestReps: 0,
      times: new Set()
    };
    const at = row.finished_at;
    if (!current.lastAt || new Date(at) >= new Date(current.lastAt)) {
      current.lastAt = at;
      current.lastKg = Number(row.kg || 0);
      current.lastReps = Number(row.reps || 0);
    }
    const kg = Number(row.kg || 0);
    const reps = Number(row.reps || 0);
    if (kg > current.bestKg || (kg === current.bestKg && reps > current.bestReps)) {
      current.bestKg = kg;
      current.bestReps = reps;
    }
    current.times.add(row.session_id);
    byExercise.set(id, current);
  });

  return Array.from(byExercise.values())
    .map((item) => ({
      exerciseId: item.exerciseId,
      displayName: item.displayName,
      lastKg: item.lastKg,
      lastReps: item.lastReps,
      lastAt: item.lastAt,
      bestKg: item.bestKg,
      bestReps: item.bestReps,
      timesPerformed: item.times.size
    }))
    .sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));
}

async function progressMuscles(userId, range) {
  const sets = await loadWorkingSets(userId, range);
  const recovery = await many(
    "SELECT muscle_id, last_trained_at FROM muscle_recovery WHERE user_id = $1",
    [userId]
  );
  const lastByMuscle = new Map(recovery.map((row) => [row.muscle_id, row.last_trained_at]));
  const byMuscle = new Map();

  sets.forEach((row) => {
    const muscleId = muscleFromExerciseId(row.exercise_id);
    const current = byMuscle.get(muscleId) || {
      muscleId,
      volumeKg: 0,
      setsCount: 0,
      lastTrainedAt: lastByMuscle.get(muscleId) || null
    };
    current.volumeKg += Number(row.volume || 0);
    current.setsCount += 1;
    if (!current.lastTrainedAt || new Date(row.finished_at) > new Date(current.lastTrainedAt)) {
      current.lastTrainedAt = row.finished_at;
    }
    byMuscle.set(muscleId, current);
  });

  return Array.from(byMuscle.values())
    .map((item) => ({ ...item, volumeKg: Math.round(item.volumeKg * 100) / 100 }))
    .sort((a, b) => b.volumeKg - a.volumeKg);
}

async function progressCalendar(userId, year, month) {
  const safeYear = Number(year) || new Date().getFullYear();
  const safeMonth = Number(month) || (new Date().getMonth() + 1);
  if (safeMonth < 1 || safeMonth > 12) throw httpError(400, "month deve ser 1 a 12");

  const rows = await many(
    `SELECT
        (s.finished_at AT TIME ZONE '${TZ}')::date AS day,
        ARRAY_AGG(s.id ORDER BY s.finished_at) AS session_ids,
        COALESCE(SUM(s.volume_kg), 0) AS volume_kg,
        COUNT(*)::int AS workouts
     FROM workout_sessions s
     WHERE ${sessionFilter("s")}
       AND EXTRACT(YEAR FROM s.finished_at AT TIME ZONE '${TZ}') = $2
       AND EXTRACT(MONTH FROM s.finished_at AT TIME ZONE '${TZ}') = $3
     GROUP BY 1
     ORDER BY 1 ASC`,
    [userId, safeYear, safeMonth]
  );

  return rows.map((row) => ({
    date: asDate(row.day),
    sessionIds: row.session_ids || [],
    volumeKg: Number(row.volume_kg || 0),
    workouts: row.workouts || 0
  }));
}

async function handle(req, res, url) {
  const pathname = url.pathname;
  const q = query(url);

  if (req.method === "GET" && matchPath(pathname, "/api/progress/exercises")) {
    const user = await requireUser(req);
    const range = parseRange(q.range || "all");
    return ok(res, { data: await progressExercises(user.id, range), range });
  }

  if (req.method === "GET" && matchPath(pathname, "/api/progress/muscles")) {
    const user = await requireUser(req);
    const range = parseRange(q.range || "month");
    return ok(res, { data: await progressMuscles(user.id, range), range });
  }

  if (req.method === "GET" && matchPath(pathname, "/api/progress/calendar")) {
    const user = await requireUser(req);
    const now = new Date();
    const year = q.year || now.getFullYear();
    const month = q.month || (now.getMonth() + 1);
    return ok(res, {
      data: await progressCalendar(user.id, year, month),
      year: Number(year),
      month: Number(month)
    });
  }

  if (req.method === "GET" && matchPath(pathname, "/api/progress")) {
    const user = await requireUser(req);
    const range = parseRange(q.range || "week");
    return ok(res, { data: await progressOverview(user, range), range });
  }

  return false;
}

module.exports = { handle };
