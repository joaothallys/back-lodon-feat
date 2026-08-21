const { httpError } = require("../../lib/http");
const { log } = require("../../lib/logger");

const TIMEOUT_MS = 45_000;
const DEFAULT_MODEL = "openai/gpt-oss-20b";
const RETIRED_MODELS = {
  "llama-3.3-70b-versatile": DEFAULT_MODEL,
  "llama-3.1-8b-instant": DEFAULT_MODEL
};

function groqUrl() {
  return process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1/chat/completions";
}

function groqModel() {
  const requested = process.env.GROQ_MODEL || DEFAULT_MODEL;
  const mapped = RETIRED_MODELS[requested];
  if (mapped && mapped !== requested) {
    log.warn("groq.model_retired", { requested, using: mapped });
    return mapped;
  }
  return requested;
}

function extractJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {}
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch (_) {}
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch (_) {}
  }
  return null;
}

async function groqRequest({ model, system, user, jsonMode }) {
  const key = process.env.GROQ_API_KEY;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const body = {
    model,
    temperature: 0.2,
    max_tokens: 4096,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  };
  if (jsonMode) body.response_format = { type: "json_object" };

  try {
    const res = await fetch(groqUrl(), {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json"
      },
      signal: controller.signal,
      body: JSON.stringify(body)
    });
    const text = await res.text();
    return { res, text };
  } finally {
    clearTimeout(timer);
  }
}

async function completeJson({ system, user }) {
  const key = process.env.GROQ_API_KEY;
  if (!key) {
    log.error("groq.missing_key");
    throw httpError(502, "ia_unavailable");
  }

  const model = groqModel();
  const attempts = [
    { jsonMode: false, label: "plain" },
    { jsonMode: true, label: "json_object" }
  ];

  let lastErr = null;
  for (const attempt of attempts) {
    const started = Date.now();
    log.info("groq.start", { model, timeoutMs: TIMEOUT_MS, mode: attempt.label });
    let res;
    let raw;
    try {
      const out = await groqRequest({ model, system, user, jsonMode: attempt.jsonMode });
      res = out.res;
      raw = out.text;
    } catch (err) {
      lastErr = err;
      log.error("groq.network", { model, mode: attempt.label, ms: Date.now() - started, ...log.errFields(err) });
      continue;
    }

    const ms = Date.now() - started;
    if (!res.ok) {
      log.error("groq.http", { model, mode: attempt.label, ms, status: res.status, body: String(raw).slice(0, 300) });
      lastErr = httpError(502, "ia_unavailable");
      continue;
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      log.error("groq.envelope", { model, mode: attempt.label, ms, ...log.errFields(err) });
      lastErr = err;
      continue;
    }

    const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message
      ? payload.choices[0].message.content
      : "";
    const parsed = extractJson(content);
    if (parsed && typeof parsed === "object") {
      log.info("groq.ok", {
        model,
        mode: attempt.label,
        ms,
        days: parsed.days ? parsed.days.length : 0
      });
      return parsed;
    }
    log.warn("groq.json", { model, mode: attempt.label, ms, preview: String(content).slice(0, 200) });
    lastErr = httpError(502, "ia_unavailable");
  }

  throw lastErr || httpError(502, "ia_unavailable");
}

module.exports = { completeJson, extractJson };
