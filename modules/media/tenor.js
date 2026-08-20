const BASE = "https://tenor.googleapis.com/v2/search";
const TIMEOUT_MS = 8000;

function pickUrl(item) {
  const formats = item && item.media_formats;
  if (!formats) return null;
  return (formats.tinygif && formats.tinygif.url)
    || (formats.nanogif && formats.nanogif.url)
    || (formats.gif && formats.gif.url)
    || null;
}

async function searchGif(name) {
  const key = process.env.TENOR_API_KEY;
  if (!key) return null;
  const q = String(name || "").trim();
  if (!q) return null;

  const params = new URLSearchParams({
    q: q + " gym exercise",
    key,
    client_key: "london-fitness",
    limit: "1",
    media_filter: "tinygif,nanogif,gif",
    contentfilter: "high",
    locale: "en_US"
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(BASE + "?" + params.toString(), { signal: ctrl.signal });
    if (!res.ok) return null;
    const json = await res.json();
    const item = json && json.results && json.results[0];
    return pickUrl(item);
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { searchGif };
