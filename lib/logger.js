const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel() {
  const raw = String(process.env.LOG_LEVEL || "info").toLowerCase();
  return LEVELS[raw] != null ? LEVELS[raw] : LEVELS.info;
}

function redact(value) {
  if (value == null) return value;
  if (typeof value === "string") {
    if (/bearer\s+/i.test(value)) return "Bearer [redacted]";
    if (value.length > 12 && /^(gsk_|lf_|eyJ)/.test(value)) return "[redacted]";
    return value;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object") {
    const out = {};
    Object.entries(value).forEach(([key, item]) => {
      const name = key.toLowerCase();
      if (/(password|token|authorization|secret|api[_-]?key|refresh)/.test(name)) {
        out[key] = "[redacted]";
      } else {
        out[key] = redact(item);
      }
    });
    return out;
  }
  return value;
}

function write(level, message, extra) {
  if (LEVELS[level] < currentLevel()) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: message
  };
  if (extra && typeof extra === "object") {
    Object.assign(line, redact(extra));
  } else if (extra != null) {
    line.detail = String(extra);
  }
  const text = JSON.stringify(line);
  if (level === "error" || level === "warn") process.stderr.write(text + "\n");
  else process.stdout.write(text + "\n");
}

function errFields(err) {
  if (!err) return {};
  return {
    err: err.message || String(err),
    status: err.status || null,
    code: err.code || null,
    stack: err.stack ? String(err.stack).split("\n").slice(0, 8).join(" | ") : null
  };
}

const log = {
  debug: (message, extra) => write("debug", message, extra),
  info: (message, extra) => write("info", message, extra),
  warn: (message, extra) => write("warn", message, extra),
  error: (message, extra) => write("error", message, extra),
  errFields
};

module.exports = { log, redact };
