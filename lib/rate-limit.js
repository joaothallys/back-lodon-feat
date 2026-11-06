const { httpError } = require("./http");
const { log } = require("./logger");

// Contadores em memória: zeram a cada deploy e valem por instância.
// Com mais de uma réplica no Railway, troque por um armazenamento compartilhado.
const MAX_KEYS = 200_000;
const MINUTE = 60_000;

const LIMITS = {
  global: { limit: 1500, windowMs: MINUTE },
  loginIpEmail: { limit: 8, windowMs: 15 * MINUTE },
  loginEmail: { limit: 30, windowMs: 15 * MINUTE },
  loginIp: { limit: 100, windowMs: 15 * MINUTE },
  register: { limit: 20, windowMs: 60 * MINUTE },
  social: { limit: 60, windowMs: 15 * MINUTE },
  refresh: { limit: 120, windowMs: 15 * MINUTE },
  planGenerate: { limit: 10, windowMs: 60 * MINUTE },
  shareCreate: { limit: 30, windowMs: 60 * MINUTE },
  mediaUpstream: { limit: 120, windowMs: MINUTE }
};

const buckets = new Map();

function enabled() {
  return process.env.RATE_LIMIT_DISABLED !== "true";
}

function prune(now) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  if (buckets.size < MAX_KEYS) return;
  // Sob inundação de chaves, descarta as mais antigas para limitar a memória.
  const excess = buckets.size - Math.floor(MAX_KEYS / 2);
  let removed = 0;
  for (const key of buckets.keys()) {
    if (removed >= excess) break;
    buckets.delete(key);
    removed += 1;
  }
}

function current(key, now) {
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) return null;
  return bucket;
}

function blocked(name, key, bucket, now) {
  log.warn("rate_limit.blocked", { limit: name, key: key.split(":")[0] });
  const err = httpError(429, "muitas tentativas. Aguarde um pouco e tente de novo");
  err.retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  return err;
}

// Só consulta: serve para contar falhas sem punir quem acerta.
function assertAllowed(name, key) {
  if (!enabled()) return;
  const now = Date.now();
  const bucket = current(key, now);
  if (bucket && bucket.count >= LIMITS[name].limit) throw blocked(name, key, bucket, now);
}

function record(name, key) {
  if (!enabled()) return;
  const now = Date.now();
  const bucket = current(key, now);
  if (bucket) {
    bucket.count += 1;
    return;
  }
  if (buckets.size >= MAX_KEYS) prune(now);
  buckets.set(key, { count: 1, resetAt: now + LIMITS[name].windowMs });
}

function consume(name, key) {
  assertAllowed(name, key);
  record(name, key);
}

function clear(key) {
  buckets.delete(key);
}

// O proxy do Railway reescreve o X-Real-IP. Sem ele (fora do Railway) usa o
// X-Forwarded-For e, por último, o socket.
function clientIp(req) {
  const real = String(req.headers["x-real-ip"] || "").trim();
  if (real) return real.slice(0, 64);
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  if (forwarded) return forwarded.slice(0, 64);
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

function reset() {
  buckets.clear();
}

module.exports = { assertAllowed, record, consume, clear, clientIp, reset };
