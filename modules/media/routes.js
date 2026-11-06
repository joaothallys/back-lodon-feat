const { json, query, fail } = require("../../lib/http");
const limiter = require("../../lib/rate-limit");
const repo = require("../exercises/repo");
const tenor = require("./tenor");
const { loadExerciseMedia, loadMuscles, loadBodyparts, loadEquipments, loadExerciseTypes } = require("./exercise-media");

const MAX_QUERY = 120;

// Só a busca que sai do cache gasta a cota paga do provedor.
function chargeUpstream(req) {
  limiter.consume("mediaUpstream", "media:" + limiter.clientIp(req));
}

function keyOf(name) {
  return String(name || "").trim().toLowerCase();
}

async function sendTaxonomy(res, loader) {
  try {
    const result = await loader();
    json(res, 200, { success: true, source: "exercisedb-v2", cached: result.cached, data: result.data });
  } catch (err) {
    fail(res, err.status || 502, err.message || "exercisedb_v2_unavailable");
  }
  return true;
}

async function handle(req, res, url) {
  const q = query(url);

  if (req.method === "GET" && url.pathname === "/api/media/muscles") {
    return sendTaxonomy(res, loadMuscles);
  }
  if (req.method === "GET" && url.pathname === "/api/media/bodyparts") {
    return sendTaxonomy(res, loadBodyparts);
  }
  if (req.method === "GET" && url.pathname === "/api/media/equipments") {
    return sendTaxonomy(res, loadEquipments);
  }
  if (req.method === "GET" && url.pathname === "/api/media/exercisetypes") {
    return sendTaxonomy(res, loadExerciseTypes);
  }

  if (req.method === "GET" && url.pathname === "/api/media/exercise") {
    const name = (q.q || q.name || "").trim().slice(0, MAX_QUERY);
    const exerciseId = (q.exerciseId || q.id || "").trim().slice(0, MAX_QUERY);
    if (!name && !exerciseId) {
      fail(res, 400, "missing q");
      return true;
    }
    try {
      const media = await loadExerciseMedia({
        q: name,
        gender: q.gender,
        exerciseId: exerciseId || null,
        beforeUpstream: () => chargeUpstream(req)
      });
      if (!media) {
        json(res, 200, { success: false, error: "not found", gifUrl: null, imageUrl: null, videoUrl: null });
        return true;
      }
      json(res, 200, { success: true, source: "exercisedb-v2", ...media });
    } catch (err) {
      fail(res, err.status || 502, err.message || "exercisedb_v2_unavailable");
    }
    return true;
  }

  if (req.method !== "GET" || url.pathname !== "/api/media/fallback") return false;

  const name = (q.q || q.name || "").trim().slice(0, MAX_QUERY);
  if (!name) {
    json(res, 400, { success: false, error: "missing q" });
    return true;
  }

  const cacheKey = keyOf(name);
  const cached = repo.getGifFallback(cacheKey);
  if (cached && cached.gifUrl) {
    json(res, 200, { success: true, gifUrl: cached.gifUrl, source: cached.source, cached: true });
    return true;
  }

  chargeUpstream(req);
  const gifUrl = await tenor.searchGif(name);
  if (!gifUrl) {
    json(res, 200, {
      success: false,
      gifUrl: null,
      source: process.env.TENOR_API_KEY ? "tenor" : "none"
    });
    return true;
  }

  repo.setGifFallback(cacheKey, gifUrl, "tenor");
  json(res, 200, { success: true, gifUrl, source: "tenor", cached: false });
  return true;
}

module.exports = { handle };
