const ExerciseDBService = require("./exercisedb-service");
const repo = require("./repo");
const { json, readBody, query } = require("../../lib/http");

const listCache = { key: "", at: 0, payload: null };
const CACHE_MS = 20000;

const syncJob = {
  running: false,
  page: 0,
  fetched: 0,
  externalTotal: 0,
  created: 0,
  updated: 0,
  failed: 0,
  message: "",
  error: null,
  resumeCursor: null
};

function clearListCache() {
  listCache.key = "";
  listCache.payload = null;
}

function claimSync() {
  if (syncJob.running) return false;
  syncJob.running = true;
  syncJob.page = 0;
  syncJob.fetched = 0;
  syncJob.created = 0;
  syncJob.updated = 0;
  syncJob.failed = 0;
  syncJob.externalTotal = 0;
  syncJob.message = "Sincronizando...";
  syncJob.error = null;
  syncJob.resumeCursor = null;
  return true;
}

function syncSnapshot() {
  const meta = repo.getSyncMeta();
  return {
    running: syncJob.running,
    page: syncJob.page,
    fetched: syncJob.fetched,
    externalTotal: syncJob.externalTotal,
    created: syncJob.created,
    updated: syncJob.updated,
    failed: syncJob.failed,
    message: syncJob.message,
    error: syncJob.error,
    count: repo.count(),
    lastSyncAt: meta.lastSyncAt,
    lastError: meta.lastError,
    lastReport: meta.lastReport
  };
}

async function syncAll() {
  if (!syncJob.running && !claimSync()) {
    return { success: false, error: "sync already running", ...syncSnapshot() };
  }

  try {
    const previous = repo.getSyncMeta().lastReport || {};
    let cursor = previous.success === false && previous.resumeCursor ? previous.resumeCursor : undefined;
    let page = cursor ? previous.resumePage || 0 : 0;
    let totalFetched = cursor ? previous.totalFetched || repo.count() : 0;
    syncJob.fetched = totalFetched;
    if (previous.error && String(previous.error).indexOf("429") >= 0) {
      syncJob.message = "Aguardando limite da ExerciseDB...";
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }

    do {
      page += 1;
      syncJob.page = page;
      syncJob.resumeCursor = cursor || null;
      syncJob.message = "Buscando página " + page + "...";
      if (page > 1 && page % 8 === 1) {
        syncJob.message = "Aguardando limite da ExerciseDB...";
        await new Promise((resolve) => setTimeout(resolve, 8000));
        syncJob.message = "Buscando página " + page + "...";
      }
      const result = await ExerciseDBService.getExercisesPage(cursor);
      const stats = repo.upsertManyFromExerciseDB(result.data);
      totalFetched += result.data.length;
      syncJob.fetched = totalFetched;
      syncJob.externalTotal = result.meta.total || syncJob.externalTotal;
      syncJob.created += stats.created;
      syncJob.updated += stats.updated;
      syncJob.failed += stats.failed;
      clearListCache();
      cursor = result.meta.hasNextPage ? result.meta.nextCursor : undefined;
      syncJob.resumeCursor = cursor || null;
      if (cursor) await new Promise((resolve) => setTimeout(resolve, 700));
    } while (cursor);

    const report = {
      success: true,
      totalFetched,
      created: syncJob.created,
      updated: syncJob.updated,
      failed: syncJob.failed
    };
    repo.setSyncMeta({ lastSyncAt: Date.now(), lastError: null, lastReport: report });
    syncJob.message = totalFetched + " exercícios encontrados.";
    syncJob.running = false;
    return report;
  } catch (err) {
    const message = err.message || String(err);
    syncJob.error = message;
    syncJob.message = "Falha: " + message;
    syncJob.running = false;
    repo.setSyncMeta({
      lastSyncAt: repo.getSyncMeta().lastSyncAt,
      lastError: message,
      lastReport: {
        success: false,
        totalFetched: syncJob.fetched,
        created: syncJob.created,
        updated: syncJob.updated,
        failed: syncJob.failed,
        error: message,
        resumeCursor: syncJob.resumeCursor || null,
        resumePage: syncJob.page || 0
      }
    });
    return {
      success: false,
      totalFetched: syncJob.fetched,
      created: syncJob.created,
      updated: syncJob.updated,
      failed: syncJob.failed,
      error: message
    };
  }
}

async function handle(req, res, url) {
  const q = query(url);
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/api/exercises") {
    const key = JSON.stringify({
      page: q.page || "1",
      limit: q.limit || "20",
      search: q.search || q.q || "",
      bodyPart: q.bodyPart || "",
      equipment: q.equipment || "",
      targetMuscle: q.targetMuscle || ""
    });
    if (listCache.payload && listCache.key === key && Date.now() - listCache.at < CACHE_MS) {
      return json(res, 200, listCache.payload);
    }
    const payload = repo.list({
      page: q.page,
      limit: q.limit,
      search: q.search || q.q,
      bodyPart: q.bodyPart,
      equipment: q.equipment,
      targetMuscle: q.targetMuscle
    });
    listCache.key = key;
    listCache.at = Date.now();
    listCache.payload = payload;
    return json(res, 200, payload);
  }

  if (req.method === "GET" && pathname === "/api/exercises/search") {
    return json(res, 200, repo.list({
      page: q.page,
      limit: q.limit,
      search: q.q || q.search
    }));
  }

  if (req.method === "GET" && pathname === "/api/exercises/filters") {
    return json(res, 200, { success: true, ...repo.getFilters() });
  }

  if (req.method === "GET" && pathname === "/api/admin/exercises/sync/status") {
    return json(res, 200, { success: true, ...syncSnapshot() });
  }

  if (req.method === "POST" && pathname === "/api/admin/exercises/sync") {
    await readBody(req);
    if (!claimSync()) {
      return json(res, 409, { success: false, error: "sync already running", ...syncSnapshot() });
    }
    syncAll().catch((err) => {
      syncJob.running = false;
      syncJob.error = err.message || String(err);
      syncJob.message = "Falha: " + syncJob.error;
    });
    return json(res, 202, { success: true, started: true, ...syncSnapshot() });
  }

  if (req.method === "GET" && pathname.startsWith("/api/exercises/")) {
    const id = decodeURIComponent(pathname.slice("/api/exercises/".length));
    if (!id || id.includes("/")) return json(res, 404, { success: false, error: "not found" });
    const item = repo.getByExternalId(id);
    if (!item) return json(res, 404, { success: false, error: "not found" });
    return json(res, 200, { success: true, data: item });
  }

  return false;
}

module.exports = { handle };
