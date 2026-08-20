const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { loadEnv } = require("./load-env");
const { CORS, json, fail, applyCors } = require("./lib/http");

loadEnv(".env");

const { pool } = require("./db/pool");
const { ensureMasterUser } = require("./lib/auth");

const modules = [
  require("./modules/auth/routes"),
  require("./modules/profile/routes"),
  require("./modules/membership/routes"),
  require("./modules/locations/routes"),
  require("./modules/plans/routes"),
  require("./modules/workouts/routes"),
  require("./modules/sessions/routes"),
  require("./modules/library/routes"),
  require("./modules/exercises/routes"),
  require("./modules/media/routes")
];

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const DOCS_PATH = path.join(__dirname, "docs", "index.html");

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
  try {
    const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));
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
      } catch (_) {}
      return json(res, db ? 200 : 503, { ok: db, db, service: "london-fitness-api" });
    }
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    json(res, 404, { success: false, error: "not found" });
  } catch (err) {
    if (err.status) return fail(res, err.status, err.message);
    const down = err.code === "ENOTFOUND" || err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT";
    console.error(err);
    json(res, down ? 503 : 500, { success: false, error: down ? "banco indisponível" : (err.message || "server error") });
  }
});

ensureMasterUser()
  .catch((err) => console.error("master user:", err.message || err))
  .finally(() => {
    server.listen(PORT, HOST, () => {
      console.log("API   http://" + HOST + ":" + PORT);
      console.log("Docs  http://" + HOST + ":" + PORT + "/docs");
    });
  });
