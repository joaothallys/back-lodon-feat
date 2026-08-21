const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { loadEnv } = require("./load-env");
const { CORS, json, fail, applyCors } = require("./lib/http");
const { log } = require("./lib/logger");

loadEnv(".env");

const { pool } = require("./db/pool");
const { ensureMasterUser } = require("./lib/auth");
const { seedCatalog, muscleCounts } = require("./modules/catalog/repo");

const modules = [
  require("./modules/auth/routes"),
  require("./modules/profile/routes"),
  require("./modules/membership/routes"),
  require("./modules/locations/routes"),
  require("./modules/plans/routes"),
  require("./modules/workouts/routes"),
  require("./modules/progress/routes"),
  require("./modules/sessions/routes"),
  require("./modules/library/routes"),
  require("./modules/exercises/routes"),
  require("./modules/media/routes")
];

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const DOCS_PATH = path.join(__dirname, "docs", "index.html");

function requestId(req) {
  const incoming = req.headers["x-request-id"];
  if (incoming && String(incoming).length < 80) return String(incoming);
  return crypto.randomUUID().slice(0, 8);
}

function watchResponse(req, res, url) {
  const started = Date.now();
  const id = requestId(req);
  res.requestId = id;
  res.setHeader("X-Request-Id", id);
  const original = res.end;
  res.end = function endWithLog(...args) {
    const status = res.statusCode || 200;
    const payload = {
      requestId: id,
      method: req.method,
      path: url.pathname,
      status,
      ms: Date.now() - started
    };
    if (status >= 500) log.error("http", payload);
    else if (status >= 400) log.warn("http", payload);
    else if (url.pathname !== "/health" && url.pathname !== "/") log.info("http", payload);
    else log.debug("http", payload);
    return original.apply(this, args);
  };
  return id;
}

async function handleApi(req, res, url) {
  for (const mod of modules) {
    const handled = await mod.handle(req, res, url);
    if (handled !== false) return;
  }
  json(res, 404, { success: false, error: "not found" });
}

function sendDocs(res) {
  const html = fs.readFileSync(DOCS_PATH);
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": html.length,
    ...CORS
  });
  res.end(html);
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
    watchResponse(req, res, url);
    if (req.method === "OPTIONS") {
      applyCors(req, res);
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    if (req.method === "GET" && (url.pathname === "/docs" || url.pathname === "/docs/")) {
      return sendDocs(res);
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      let db = false;
      try {
        await pool.query("SELECT 1");
        db = true;
      } catch (err) {
        log.error("health.db", log.errFields(err));
      }
      return json(res, db ? 200 : 503, { ok: db, db, service: "london-fitness-api" });
    }
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    json(res, 404, { success: false, error: "not found" });
  } catch (err) {
    const id = res.requestId;
    if (err.status) {
      log.warn("request.fail", { requestId: id, path: url && url.pathname, ...log.errFields(err) });
      return fail(res, err.status, err.message);
    }
    const down = err.code === "ENOTFOUND" || err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT";
    log.error("request.crash", { requestId: id, path: url && url.pathname, ...log.errFields(err) });
    fail(res, down ? 503 : 500, down ? "banco indisponível" : "server error");
  }
});

process.on("unhandledRejection", (err) => {
  log.error("unhandledRejection", log.errFields(err));
});

process.on("uncaughtException", (err) => {
  log.error("uncaughtException", log.errFields(err));
});

async function boot() {
  try {
    const user = await ensureMasterUser();
    if (user) log.info("master.ready", { email: user.email });
  } catch (err) {
    log.error("master.fail", log.errFields(err));
  }
  try {
    const count = await seedCatalog();
    const muscles = await muscleCounts();
    log.info("catalog.ready", {
      count,
      muscles: Object.fromEntries(muscles.map((row) => [row.muscle, row.total]))
    });
  } catch (err) {
    log.error("catalog.seed_fail", log.errFields(err));
  }
  server.listen(PORT, HOST, () => {
    log.info("server.listen", { host: HOST, port: PORT });
  });
}

boot();
