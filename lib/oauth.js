const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const { httpError } = require("./http");

const JWKS_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const jwksCache = new Map();

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
const APPLE_ISSUER = "https://appleid.apple.com";

const DUMMY_EMAILS = new Set([
  "apple_user@privaterelay.appleid.com",
  "user@privaterelay.appleid.com"
]);

function parseClientIds(...keys) {
  const ids = [];
  keys.forEach((key) => {
    String(process.env[key] || "")
      .split(/[,;\s]+/)
      .map((value) => value.trim())
      .filter(Boolean)
      .forEach((value) => ids.push(value));
  });
  return [...new Set(ids)];
}

function googleAudiences() {
  return parseClientIds("GOOGLE_CLIENT_IDS", "GOOGLE_CLIENT_ID");
}

function appleAudiences() {
  return parseClientIds("APPLE_CLIENT_IDS", "APPLE_CLIENT_ID");
}

function looksLikeJwt(value) {
  return typeof value === "string" && value.split(".").length === 3;
}

function normalizeEmail(value) {
  if (!value || typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  if (!email.includes("@") || DUMMY_EMAILS.has(email)) return null;
  return email;
}

function isEmailVerified(value) {
  return value === true || value === "true";
}

function sha256Hex(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function sha256Base64Url(value) {
  return crypto.createHash("sha256").update(String(value)).digest("base64url");
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
    return { ok: response.ok, status: response.status, body };
  } catch (err) {
    if (err.name === "AbortError") throw httpError(503, "provedor de login indisponível");
    throw httpError(503, "provedor de login indisponível");
  } finally {
    clearTimeout(timer);
  }
}

async function getJwks(url) {
  const cached = jwksCache.get(url);
  if (cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;
  const { ok, body } = await fetchJson(url);
  if (!ok || !body || !Array.isArray(body.keys) || !body.keys.length) {
    throw httpError(503, "não foi possível obter as chaves do provedor");
  }
  jwksCache.set(url, { keys: body.keys, fetchedAt: Date.now() });
  return body.keys;
}

function jwkToPem(jwk) {
  return crypto.createPublicKey({ key: jwk, format: "jwk" }).export({ type: "spki", format: "pem" });
}

function verifyJwtWithJwks(token, keys, options) {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || !decoded.header) throw httpError(401, "token social inválido");
  const jwk = keys.find((key) => key.kid === decoded.header.kid) || keys[0];
  if (!jwk) throw httpError(401, "chave pública do provedor não encontrada");
  try {
    return jwt.verify(token, jwkToPem(jwk), options);
  } catch (_) {
    throw httpError(401, "token social inválido ou expirado");
  }
}

function assertNonce(payloadNonce, rawNonce) {
  if (!rawNonce) return;
  const expected = String(payloadNonce || "");
  const raw = String(rawNonce);
  if (expected === raw || expected === sha256Hex(raw) || expected === sha256Base64Url(raw)) return;
  throw httpError(401, "nonce inválido");
}

function identityFromClaims(provider, claims, fallbackName) {
  const email = normalizeEmail(claims.email);
  return {
    provider,
    sub: String(claims.sub || claims.id || ""),
    email,
    emailVerified: isEmailVerified(claims.email_verified),
    name: claims.name || fallbackName || null
  };
}

async function verifyGoogleIdToken(idToken) {
  const audiences = googleAudiences();
  if (!audiences.length) throw httpError(503, "login Google não configurado");
  const keys = await getJwks(GOOGLE_JWKS_URL);
  const payload = verifyJwtWithJwks(idToken, keys, {
    algorithms: ["RS256"],
    issuer: GOOGLE_ISSUERS,
    audience: audiences
  });
  const identity = identityFromClaims("google", payload);
  if (!identity.sub) throw httpError(401, "token Google sem identificador");
  if (!identity.email) throw httpError(401, "não foi possível obter o e-mail do Google");
  return identity;
}

async function verifyGoogleAccessToken(accessToken) {
  const audiences = googleAudiences();
  if (!audiences.length) throw httpError(503, "login Google não configurado");
  const info = await fetchJson(
    "https://oauth2.googleapis.com/tokeninfo?access_token=" + encodeURIComponent(accessToken)
  );
  if (!info.ok || !info.body) throw httpError(401, "token Google inválido");
  const aud = info.body.aud || "";
  const azp = info.body.azp || "";
  if (!audiences.includes(aud) && !audiences.includes(azp)) {
    throw httpError(401, "token Google não pertence a este app");
  }
  const { ok, body } = await fetchJson(GOOGLE_USERINFO_URL, {
    headers: { Authorization: "Bearer " + accessToken }
  });
  if (!ok || !body) throw httpError(401, "token Google inválido");
  const identity = identityFromClaims("google", { ...info.body, ...body });
  if (!identity.sub) throw httpError(401, "token Google sem identificador");
  if (!identity.email) throw httpError(401, "não foi possível obter o e-mail do Google");
  return identity;
}

async function verifyGoogleToken({ idToken, accessToken }) {
  if (idToken && looksLikeJwt(idToken)) return verifyGoogleIdToken(idToken);
  if (accessToken && looksLikeJwt(accessToken)) return verifyGoogleIdToken(accessToken);
  if (accessToken) return verifyGoogleAccessToken(accessToken);
  if (idToken) return verifyGoogleAccessToken(idToken);
  throw httpError(400, "idToken ou accessToken é obrigatório");
}

async function verifyAppleIdentityToken(identityToken, nonce) {
  const audiences = appleAudiences();
  if (!audiences.length) throw httpError(503, "login Apple não configurado");
  if (!identityToken || !looksLikeJwt(identityToken)) {
    throw httpError(401, "identityToken Apple inválido");
  }
  const keys = await getJwks(APPLE_JWKS_URL);
  const payload = verifyJwtWithJwks(identityToken, keys, {
    algorithms: ["RS256"],
    issuer: APPLE_ISSUER,
    audience: audiences
  });
  assertNonce(payload.nonce, nonce);
  const identity = identityFromClaims("apple", payload);
  if (!identity.sub) throw httpError(401, "token Apple sem identificador");
  return identity;
}

module.exports = {
  verifyGoogleToken,
  verifyAppleIdentityToken,
  normalizeEmail,
  looksLikeJwt
};
