const { json, query } = require("../../lib/http");
const repo = require("../exercises/repo");
const tenor = require("./tenor");

function keyOf(name) {
  return String(name || "").trim().toLowerCase();
}

async function handle(req, res, url) {
  if (req.method !== "GET" || url.pathname !== "/api/media/fallback") return false;

  const q = query(url);
  const name = (q.q || q.name || "").trim();
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
