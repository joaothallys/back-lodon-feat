const crypto = require("node:crypto");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { one, many, camel } = require("../db/pool");
const { httpError } = require("./http");

const BCRYPT_ROUNDS = 12;

function secret() {
  const value = process.env.JWT_SECRET;
  if (!value) throw new Error("JWT_SECRET não configurada");
  return value;
}

function hashRefresh(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function parseTtl(value, fallbackMs) {
  const raw = String(value || "");
  const match = /^(\d+)([smhd])$/.exec(raw);
  if (!match) return fallbackMs;
  const n = Number(match[1]);
  const unit = match[2];
  const map = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return n * map[unit];
}

async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function signAccess(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    secret(),
    { expiresIn: process.env.JWT_ACCESS_TTL || "15m" }
  );
}

async function createSession(user, device) {
  const refreshToken = crypto.randomBytes(48).toString("hex");
  const ttl = parseTtl(process.env.JWT_REFRESH_TTL, 30 * 86_400_000);
  const expiresAt = new Date(Date.now() + ttl);
  const session = await one(
    `INSERT INTO user_sessions (user_id, refresh_token_hash, device, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [user.id, hashRefresh(refreshToken), device || null, expiresAt]
  );
  return {
    accessToken: signAccess(user),
    refreshToken,
    tokenType: "Bearer",
    expiresIn: Math.round(parseTtl(process.env.JWT_ACCESS_TTL, 15 * 60_000) / 1000),
    sessionId: session.id
  };
}

function getBearer(req) {
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1] : null;
}

async function loadProfileExtras(userId) {
  const [equipment, focus] = await Promise.all([
    many("SELECT equipment_id FROM user_profile_equipment WHERE user_id = $1", [userId]),
    many("SELECT muscle_id FROM user_profile_focus WHERE user_id = $1", [userId])
  ]);
  return {
    equipment: equipment.map((row) => row.equipment_id),
    focus: focus.map((row) => row.muscle_id)
  };
}

async function publicUser(user) {
  const profile = await one("SELECT * FROM user_profiles WHERE user_id = $1", [user.id]);
  const extras = await loadProfileExtras(user.id);
  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: user.status,
    onboardingDone: user.onboarding_done,
    lastLoginAt: user.last_login_at,
    createdAt: user.created_at,
    updatedAt: user.updated_at,
    profile: profile ? { ...camel(profile), ...extras } : null
  };
}

async function requireUser(req) {
  const token = getBearer(req);
  if (!token) throw httpError(401, "token ausente");
  let payload;
  try {
    payload = jwt.verify(token, secret());
  } catch (_) {
    throw httpError(401, "token inválido ou expirado");
  }
  const user = await one("SELECT * FROM users WHERE id = $1", [payload.sub]);
  if (!user || user.status !== "active") throw httpError(401, "usuário indisponível");
  return user;
}

async function rotateRefresh(refreshToken, device) {
  if (!refreshToken) throw httpError(400, "refreshToken obrigatório");
  const row = await one(
    `SELECT s.*, u.email, u.role, u.status
     FROM user_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.refresh_token_hash = $1`,
    [hashRefresh(refreshToken)]
  );
  if (!row || row.revoked_at || new Date(row.expires_at) < new Date()) {
    throw httpError(401, "refresh token inválido");
  }
  if (row.status !== "active") throw httpError(401, "usuário indisponível");
  await one("UPDATE user_sessions SET revoked_at = now() WHERE id = $1 RETURNING id", [row.id]);
  const user = { id: row.user_id, email: row.email, role: row.role };
  return createSession(user, device);
}

async function revokeRefresh(refreshToken) {
  if (!refreshToken) return;
  await one(
    "UPDATE user_sessions SET revoked_at = now() WHERE refresh_token_hash = $1 AND revoked_at IS NULL RETURNING id",
    [hashRefresh(refreshToken)]
  );
}

function newMemberCode() {
  const year = new Date().getFullYear();
  const n = String(Math.floor(1000 + Math.random() * 9000));
  return "LF-" + year + "-" + n;
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  requireUser,
  publicUser,
  rotateRefresh,
  revokeRefresh,
  newMemberCode,
  loadProfileExtras
};
