const BASE_URL = process.env.EXERCISEDB_BASE_URL || "https://oss.exercisedb.dev/api/v1";
const TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;
const PAGE_LIMIT = 25;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(err) {
  const status = err && err.status;
  if (err && err.code === "ABORT") return true;
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
  return false;
}

function shouldNotRetry(status) {
  return status === 400 || status === 401 || status === 403 || status === 404;
}

async function request(path, attempt) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(BASE_URL + path, { signal: ctrl.signal });
    if (!res.ok) {
      const err = new Error("ExerciseDB error: " + res.status);
      err.status = res.status;
      throw err;
    }
    let json;
    try {
      json = await res.json();
    } catch (e) {
      throw new Error("JSON inválido da ExerciseDB");
    }
    if (!json || typeof json !== "object") throw new Error("Resposta inválida da ExerciseDB");
    return json;
  } catch (err) {
    if (err && err.name === "AbortError") {
      const timeout = new Error("timeout");
      timeout.code = "ABORT";
      timeout.status = 504;
      err = timeout;
    }
    const tryCount = attempt || 1;
    if (shouldNotRetry(err.status)) throw err;
    if (isRetryable(err) && tryCount < MAX_RETRIES) {
      const backoff = err.status === 429 ? 12000 * tryCount : 400 * tryCount;
      await wait(backoff);
      return request(path, tryCount + 1);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function assertPage(json) {
  if (!json || json.success === false) throw new Error("Resposta sem sucesso da ExerciseDB");
  if (!json.meta) throw new Error("Resposta sem meta");
  if (!Array.isArray(json.data)) throw new Error("Resposta sem data");
  return json;
}

const ExerciseDBService = {
  async getExercises() {
    return this.getExercisesPage();
  },

  async getExercisesPage(cursor) {
    const params = new URLSearchParams();
    params.set("limit", String(PAGE_LIMIT));
    if (cursor) params.set("after", cursor);
    const json = await request("/exercises?" + params.toString());
    return assertPage(json);
  },

  async getAllExercises(onPage) {
    const exercises = [];
    let cursor;
    let page = 0;
    do {
      const result = await this.getExercisesPage(cursor);
      page += 1;
      exercises.push(...result.data);
      if (typeof onPage === "function") {
        onPage({
          page,
          fetched: exercises.length,
          total: result.meta.total || exercises.length,
          nextCursor: result.meta.nextCursor || null
        });
      }
      cursor = result.meta.hasNextPage ? result.meta.nextCursor : undefined;
      if (cursor) await wait(450);
    } while (cursor);
    return exercises;
  },

  async getExerciseById(id) {
    const json = await request("/exercises/" + encodeURIComponent(id));
    if (!json || !json.data) throw new Error("Resposta sem data");
    return json.data;
  }
};

module.exports = ExerciseDBService;
