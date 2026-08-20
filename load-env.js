const fs = require("node:fs");
const path = require("node:path");

function envPath(file) {
  const local = path.join(__dirname, file);
  if (fs.existsSync(local)) return local;
  return path.join(__dirname, "..", file);
}

function loadEnv(file) {
  const full = envPath(file);
  if (!fs.existsSync(full)) return {};
  const out = {};
  fs.readFileSync(full, "utf8").split(/\r?\n/).forEach((line) => {
    const text = line.trim();
    if (!text || text.startsWith("#")) return;
    const idx = text.indexOf("=");
    if (idx < 0) return;
    const key = text.slice(0, idx).trim();
    let value = text.slice(idx + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
    if (process.env[key] == null) process.env[key] = value;
  });
  return out;
}

module.exports = { loadEnv };
