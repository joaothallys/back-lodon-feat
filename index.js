const http = require("node:http");
const { loadEnv } = require("./load-env");
const { CORS, json, applyCors } = require("./lib/http");
const exercises = require("./modules/exercises/routes");
const media = require("./modules/media/routes");

loadEnv(".env");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

async function handleApi(req, res, url) {
  if (await media.handle(req, res, url)) return;
  const handled = await exercises.handle(req, res, url);
  if (handled === false) json(res, 404, { success: false, error: "not found" });
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
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      json(res, 200, { ok: true });
      return;
    }
    if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);
    json(res, 404, { success: false, error: "not found" });
  } catch (err) {
    json(res, 500, { success: false, error: err.message || "server error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log("API  http://" + HOST + ":" + PORT);
});
