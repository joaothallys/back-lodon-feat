const crypto = require("node:crypto");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { one, many, camel, pool } = require("../db/pool");
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
  if (!hash) return false;
  return bcrypt.compare(password, hash);
}

function intervalDays(interval) {
  if (interval === "yearly") return 365;
  if (interval === "quarterly") return 90;
  return 30;
}

async function createDefaultMembership(client, userId) {
  const plan = (await client.query(
    "SELECT * FROM membership_plans WHERE active = true ORDER BY amount ASC LIMIT 1"
  )).rows[0];
  const unit = (await client.query(
    "SELECT * FROM gym_units WHERE active = true ORDER BY name ASC LIMIT 1"
  )).rows[0];
  if (!plan) return null;

  let memberCode = newMemberCode();
  for (let i = 0; i < 5; i += 1) {
    const exists = (await client.query("SELECT 1 FROM memberships WHERE member_code = $1", [memberCode])).rowCount;
    if (!exists) break;
    memberCode = newMemberCode();
  }

  const days = intervalDays(plan.interval);
  const started = new Date();
  const next = new Date(started.getTime() + days * 86400000);
  const membership = (await client.query(
    `INSERT INTO memberships (user_id, plan_id, unit_id, member_code, status, started_at, expires_at, next_payment_at)
     VALUES ($1, $2, $3, $4, 'ativa', CURRENT_DATE, $5, $5)
     RETURNING *`,
    [userId, plan.id, unit ? unit.id : null, memberCode, next.toISOString().slice(0, 10)]
  )).rows[0];

  await client.query(
    `INSERT INTO payments (membership_id, user_id, amount, due_date, status)
     VALUES ($1, $2, $3, $4, 'em_aberto')`,
    [membership.id, userId, plan.amount, membership.next_payment_at]
  );
  return membership;
}

function providerColumn(provider) {
  if (provider === "google") return "google_id";
  if (provider === "apple") return "apple_id";
  throw httpError(400, "provedor social inválido");
}

function assertSocialUser(user) {
  if (!user) return;
  if (user.status === "deleted") throw httpError(403, "esta conta foi excluída");
  if (user.status !== "active") throw httpError(401, "usuário indisponível");
}

function syntheticSocialEmail(provider, sub) {
  const digest = crypto.createHash("sha256").update(provider + ":" + sub).digest("hex").slice(0, 24);
  return provider + "." + digest + "@signin.londonfitness.local";
}

function socialDisplayName(name, email, provider) {
  const trimmed = name && String(name).trim();
  if (trimmed) return trimmed.slice(0, 80);
  if (email && !email.endsWith("@signin.londonfitness.local")) {
    const local = email.split("@")[0].replace(/[._-]+/g, " ").trim();
    if (local) return local.slice(0, 80);
  }
  return provider === "apple" ? "Usuário Apple" : "Usuário Google";
}

async function upsertOauthIdentity(client, { userId, provider, sub, email, emailVerified }) {
  const run = client && client.query
    ? async (sql, params) => (await client.query(sql, params)).rows[0]
    : (sql, params) => one(sql, params);
  const existing = await run(
    "SELECT user_id FROM oauth_identities WHERE provider = $1 AND provider_sub = $2",
    [provider, sub]
  );
  if (existing && existing.user_id !== userId) {
    throw httpError(409, "esta conta social já está vinculada a outro usuário");
  }
  return run(
    `INSERT INTO oauth_identities (user_id, provider, provider_sub, email, email_verified)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (provider, provider_sub)
     DO UPDATE SET
       email = COALESCE(EXCLUDED.email, oauth_identities.email),
       email_verified = EXCLUDED.email_verified,
       updated_at = now()
     RETURNING *`,
    [userId, provider, sub, email || null, Boolean(emailVerified)]
  );
}

async function touchLogin(userId, extraSet, extraParams) {
  const sets = ["last_login_at = now()", "updated_at = now()"];
  const params = [];
  if (extraSet) {
    sets.unshift(extraSet);
    params.push(...extraParams);
  }
  params.push(userId);
  return one(
    `UPDATE users SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
    params
  );
}

async function createSocialUser({ provider, sub, email, emailVerified, name }) {
  const column = providerColumn(provider);
  const finalEmail = email || syntheticSocialEmail(provider, sub);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const user = (await client.query(
      `INSERT INTO users (email, password_hash, ${column})
       VALUES ($1, NULL, $2)
       RETURNING *`,
      [finalEmail, sub]
    )).rows[0];
    await client.query(
      `INSERT INTO user_profiles (user_id, name, goal, level, environment, training_days, session_duration_min)
       VALUES ($1, $2, 'hipertrofia', 'iniciante', 'academia', 4, 60)`,
      [user.id, socialDisplayName(name, finalEmail, provider)]
    );
    await createDefaultMembership(client, user.id);
    await upsertOauthIdentity(client, { userId: user.id, provider, sub, email, emailVerified });
    await client.query("COMMIT");
    return user;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

function emailTakenMessage(user) {
  const social = [];
  if (user.google_id) social.push("Google");
  if (user.apple_id) social.push("Apple");
  if (social.length && !user.password_hash) {
    return "e-mail já cadastrado. Entre com " + social.join(" ou ");
  }
  if (social.length) {
    return "e-mail já cadastrado. Faça login ou entre com " + social.join(" ou ");
  }
  return "e-mail já cadastrado. Faça login";
}

async function findSocialUser(provider, sub, email) {
  const column = providerColumn(provider);
  const byProvider = await one(`SELECT * FROM users WHERE ${column} = $1`, [sub]);
  if (byProvider) return { user: byProvider, matchedBy: "provider" };

  const identity = await one(
    "SELECT * FROM oauth_identities WHERE provider = $1 AND provider_sub = $2",
    [provider, sub]
  );
  if (identity) {
    const user = await one("SELECT * FROM users WHERE id = $1", [identity.user_id]);
    if (user) return { user, matchedBy: "provider" };
  }

  if (email) {
    const byEmail = await one("SELECT * FROM users WHERE email = $1", [email]);
    if (byEmail) return { user: byEmail, matchedBy: "email" };
  }

  return { user: null, matchedBy: null };
}

async function attachSocialAndLogin(user, { provider, sub, email, emailVerified, device }) {
  const column = providerColumn(provider);
  assertSocialUser(user);
  if (user[column] && user[column] !== sub) {
    throw httpError(409, "este e-mail já está vinculado a outra conta " + provider);
  }
  user = await touchLogin(user.id, user[column] ? null : `${column} = $1`, user[column] ? [] : [sub]);
  await upsertOauthIdentity(null, { userId: user.id, provider, sub, email, emailVerified });
  const tokens = await createSession(user, device);
  return { user, tokens, created: false, message: "Já existe uma conta com este e-mail" };
}

async function loginWithSocial({ provider, sub, email, emailVerified, name, device }) {
  if (!sub) throw httpError(401, "token social sem identificador");

  let { user, matchedBy } = await findSocialUser(provider, sub, email);
  if (user && user.status === "deleted") {
    await purgeUserRecord(user.id);
    ({ user, matchedBy } = await findSocialUser(provider, sub, email));
  }

  if (user) {
    if (matchedBy === "email" && !emailVerified) {
      assertSocialUser(user);
      throw httpError(409, emailTakenMessage(user));
    }
    return attachSocialAndLogin(user, { provider, sub, email, emailVerified, device });
  }

  try {
    user = await createSocialUser({ provider, sub, email, emailVerified, name });
  } catch (err) {
    if (err.code !== "23505") throw err;
    let again = await findSocialUser(provider, sub, email || syntheticSocialEmail(provider, sub));
    if (again.user && again.user.status === "deleted") {
      await purgeUserRecord(again.user.id);
      again = await findSocialUser(provider, sub, email || syntheticSocialEmail(provider, sub));
      if (!again.user) {
        user = await createSocialUser({ provider, sub, email, emailVerified, name });
        user = await touchLogin(user.id);
        const tokens = await createSession(user, device);
        return { user, tokens, created: true, message: "Conta criada" };
      }
    }
    if (!again.user) throw err;
    if (again.matchedBy === "email" && !emailVerified) {
      assertSocialUser(again.user);
      throw httpError(409, emailTakenMessage(again.user));
    }
    return attachSocialAndLogin(again.user, { provider, sub, email, emailVerified, device });
  }

  user = await touchLogin(user.id);
  const tokens = await createSession(user, device);
  return { user, tokens, created: true, message: "Conta criada" };
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

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function masterEmail() {
  return String(process.env.MASTER_EMAIL || "xavier.y@example.org").trim().toLowerCase();
}

async function findMasterUser() {
  return one("SELECT * FROM users WHERE email = $1 AND role = 'admin' AND status = 'active'", [masterEmail()]);
}

async function ensureMasterUser() {
  const password = process.env.MASTER_PASSWORD;
  if (!password) {
    console.warn("MASTER_PASSWORD não configurada — usuário mestre não foi criado");
    return null;
  }
  const email = masterEmail();
  const passwordHash = await hashPassword(password);
  const existing = await one("SELECT * FROM users WHERE email = $1", [email]);
  if (existing) {
    return one(
      `UPDATE users
       SET password_hash = $1, role = 'admin', status = 'active', updated_at = now()
       WHERE id = $2
       RETURNING *`,
      [passwordHash, existing.id]
    );
  }
  const user = await one(
    `INSERT INTO users (email, password_hash, role, status, onboarding_done)
     VALUES ($1, $2, 'admin', 'active', true)
     RETURNING *`,
    [email, passwordHash]
  );
  await one(
    `INSERT INTO user_profiles (user_id, name, goal, level, environment, training_days, session_duration_min)
     VALUES ($1, 'London Admin', 'hipertrofia', 'avancado', 'academia', 5, 60)
     ON CONFLICT (user_id) DO NOTHING
     RETURNING user_id`,
    [user.id]
  );
  return user;
}

async function userFromMasterKey(token) {
  const key = process.env.MASTER_KEY;
  if (!key || !token || !safeEqual(token, key)) return null;
  const user = await findMasterUser();
  if (!user) throw httpError(401, "usuário mestre indisponível");
  return user;
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
  const [profile, identities] = await Promise.all([
    one("SELECT * FROM user_profiles WHERE user_id = $1", [user.id]),
    many("SELECT provider FROM oauth_identities WHERE user_id = $1", [user.id]).catch(() => [])
  ]);
  const extras = await loadProfileExtras(user.id);
  const providers = new Set((identities || []).map((row) => row.provider));
  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: user.status,
    onboardingDone: user.onboarding_done,
    lastLoginAt: user.last_login_at,
    deletedAt: user.deleted_at || null,
    googleLinked: Boolean(user.google_id) || providers.has("google"),
    appleLinked: Boolean(user.apple_id) || providers.has("apple"),
    createdAt: user.created_at,
    updatedAt: user.updated_at,
    profile: profile ? { ...camel(profile), ...extras } : null
  };
}

async function requireUser(req) {
  const token = getBearer(req) || req.headers["x-master-key"];
  if (!token) throw httpError(401, "token ausente");
  const master = await userFromMasterKey(token);
  if (master) return master;
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

async function purgeUserRecord(userId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const shares = await client.query("SELECT to_regclass('public.workout_shares') AS rel");
    if (shares.rows[0] && shares.rows[0].rel) {
      await client.query("DELETE FROM workout_shares WHERE user_id = $1", [userId]);
    }
    const removed = (await client.query(
      "DELETE FROM users WHERE id = $1 RETURNING id",
      [userId]
    )).rows[0];
    await client.query("COMMIT");
    return removed || null;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

async function deleteOwnAccount(user) {
  if (!user) throw httpError(401, "usuário indisponível");
  if (user.role === "admin") throw httpError(403, "esta conta não pode ser excluída por aqui");
  const existing = await one("SELECT id FROM users WHERE id = $1", [user.id]);
  if (!existing) throw httpError(409, "conta já excluída");
  const removed = await purgeUserRecord(user.id);
  if (!removed) throw httpError(409, "conta já excluída");
  return { id: user.id, status: "deleted", deleted_at: new Date().toISOString() };
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
  deleteOwnAccount,
  newMemberCode,
  loadProfileExtras,
  ensureMasterUser,
  createDefaultMembership,
  loginWithSocial,
  emailTakenMessage
};
