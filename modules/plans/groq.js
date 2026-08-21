const { httpError } = require("../../lib/http");
const { log } = require("../../lib/logger");

const TIMEOUT_MS = 45_000;
const DEFAULT_MODEL = "openai/gpt-oss-120b";
const RETIRED_MODELS = {
  "llama-3.3-70b-versatile": DEFAULT_MODEL,
  "llama-3.1-8b-instant": "openai/gpt-oss-20b"
};

function groqUrl() {
  return process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1/chat/completions";
}

function groqModel() {
  const requested = process.env.GROQ_MODEL || DEFAULT_MODEL;
  const mapped = RETIRED_MODELS[requested];
  if (mapped) {
    log.warn("groq.model_retired", { requested, using: mapped });
    return mapped;
  }
  return requested;
}

async function completeJson({ system, user }) {
  const key = process.env.GROQ_API_KEY;
  if (!key) {
    log.error("groq.missing_key");
    throw httpError(502, "ia_unavailable");
  }

  const model = groqModel();
  const started = Date.now();
  log.info("groq.start", { model, timeoutMs: TIMEOUT_MS });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(groqUrl(), {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json"
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: user }
        ]
      })
    });
  } catch (err) {
    log.error("groq.network", { model, ms: Date.now() - started, ...log.errFields(err) });
    throw httpError(502, "ia_unavailable");
  } finally {
    clearTimeout(timer);
  }

  const ms = Date.now() - started;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    log.error("groq.http", { model, ms, status: res.status, body: body.slice(0, 300) });
    throw httpError(502, "ia_unavailable");
  }
  const payload = await res.json();
  const text = payload && payload.choices && payload.choices[0] && payload.choices[0].message
    ? payload.choices[0].message.content
    : "";
  try {
    const parsed = JSON.parse(text);
    log.info("groq.ok", { model, ms, days: parsed && parsed.days ? parsed.days.length : 0 });
    return parsed;
  } catch (err) {
    log.error("groq.json", { model, ms, preview: String(text).slice(0, 200), ...log.errFields(err) });
    throw httpError(502, "ia_unavailable");
  }
}

module.exports = { completeJson };
