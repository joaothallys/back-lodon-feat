const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization"
};

const MAX_BODY = 1_000_000;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    ...CORS
  });
  res.end(payload);
}

function ok(res, extra = {}, status = 200) {
  return json(res, status, { success: true, ...extra });
}

function fail(res, status, error) {
  const body = { success: false, error };
  if (res.requestId) body.requestId = res.requestId;
  return json(res, status, body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("payload too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (_) {
    const err = new Error("json inválido");
    err.status = 400;
    throw err;
  }
}

function query(url) {
  const out = {};
  url.searchParams.forEach((value, key) => { out[key] = value; });
  return out;
}

function applyCors(req, res) {
  Object.entries(CORS).forEach(([key, value]) => res.setHeader(key, value));
}

function matchPath(pathname, pattern) {
  const a = pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  const b = pattern.replace(/\/+$/, "").split("/").filter(Boolean);
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < a.length; i += 1) {
    if (b[i].startsWith(":")) params[b[i].slice(1)] = decodeURIComponent(a[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

function required(body, fields) {
  fields.forEach((field) => {
    if (body[field] == null || body[field] === "") {
      const err = new Error("campo obrigatório: " + field);
      err.status = 400;
      throw err;
    }
  });
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = {
  CORS,
  json,
  ok,
  fail,
  readBody,
  readJson,
  query,
  applyCors,
  matchPath,
  required,
  httpError
};
