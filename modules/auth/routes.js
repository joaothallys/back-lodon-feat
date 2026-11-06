const { one, pool } = require("../../db/pool");
const { ok, readJson, required, matchPath, httpError } = require("../../lib/http");
const {
  hashPassword,
  verifyPassword,
  burnPasswordCheck,
  createSession,
  requireUser,
  publicUser,
  rotateRefresh,
  revokeRefresh,
  deleteOwnAccount,
  createDefaultMembership,
  loginWithSocial,
  emailTakenMessage
} = require("../../lib/auth");
const { verifyGoogleToken, verifyAppleIdentityToken } = require("../../lib/oauth");
const limiter = require("../../lib/rate-limit");
const { notifySignup } = require("../../lib/discord");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAME_MAX = 80;
const PHONE_MAX = 20;
const PASSWORD_MAX = 200;

function registerFields(body) {
  const email = String(body.email).trim().toLowerCase();
  const name = String(body.name).trim();
  const phone = body.phone == null || body.phone === "" ? null : String(body.phone).trim();
  const password = String(body.password);
  if (email.length > 254 || !EMAIL_RE.test(email)) throw httpError(400, "e-mail inválido");
  if (!name || name.length > NAME_MAX) throw httpError(400, "nome inválido");
  if (phone && phone.length > PHONE_MAX) throw httpError(400, "telefone inválido");
  if (password.length < 6) throw httpError(400, "senha deve ter ao menos 6 caracteres");
  if (password.length > PASSWORD_MAX) throw httpError(400, "senha muito longa");
  return { email, name, phone, password };
}

function loginKeys(req, email) {
  const ip = limiter.clientIp(req);
  return [
    ["loginIpEmail", "login-ip-email:" + ip + ":" + email],
    ["loginEmail", "login-email:" + email],
    ["loginIp", "login-ip:" + ip]
  ];
}

function appleNameFromBody(body) {
  if (body.name) return String(body.name).trim();
  const full = body.fullName || body.full_name;
  if (!full || typeof full !== "object") return "";
  return [full.givenName, full.familyName].filter(Boolean).join(" ").trim();
}

async function handle(req, res, url) {
  const pathname = url.pathname;

  if (req.method === "POST" && matchPath(pathname, "/api/auth/register")) {
    limiter.consume("register", "register:" + limiter.clientIp(req));
    const body = await readJson(req);
    required(body, ["email", "password", "name"]);
    const { email, name, phone, password } = registerFields(body);
    const exists = await one("SELECT * FROM users WHERE email = $1", [email]);
    if (exists) throw httpError(409, emailTakenMessage(exists));

    const passwordHash = await hashPassword(password);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const user = (await client.query(
        `INSERT INTO users (email, phone, password_hash)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [email, phone, passwordHash]
      )).rows[0];
      await client.query(
        `INSERT INTO user_profiles (user_id, name, gender, goal, level, environment, training_days, session_duration_min)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          user.id,
          name,
          body.gender || null,
          body.goal || "hipertrofia",
          body.level || "iniciante",
          body.environment || "academia",
          Number(body.trainingDays) || 4,
          Number(body.sessionDurationMin) || 60
        ]
      );
      await createDefaultMembership(client, user.id);
      await client.query("COMMIT");
      const tokens = await createSession(user, body.device);
      notifySignup({ name, email, provider: "email" });
      return ok(res, { data: await publicUser(user), ...tokens }, 201);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  if (req.method === "POST" && matchPath(pathname, "/api/auth/login")) {
    const body = await readJson(req);
    required(body, ["email", "password"]);
    const email = String(body.email).trim().toLowerCase().slice(0, 254);
    const keys = loginKeys(req, email);
    keys.forEach(([name, key]) => limiter.assertAllowed(name, key));
    const fail = (message) => {
      keys.forEach(([name, key]) => limiter.record(name, key));
      return httpError(401, message);
    };
    const user = await one("SELECT * FROM users WHERE email = $1", [email]);
    if (!user || user.status !== "active") {
      await burnPasswordCheck(body.password);
      throw fail("credenciais inválidas");
    }
    if (!user.password_hash) throw fail("esta conta usa login social");
    const valid = await verifyPassword(String(body.password), user.password_hash);
    if (!valid) throw fail("credenciais inválidas");
    limiter.clear(keys[0][1]);
    await one("UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = $1 RETURNING id", [user.id]);
    const tokens = await createSession(user, body.device);
    return ok(res, { data: await publicUser(user), ...tokens });
  }

  if (req.method === "POST" && matchPath(pathname, "/api/auth/google")) {
    limiter.consume("social", "social:" + limiter.clientIp(req));
    const body = await readJson(req);
    const idToken = body.idToken || body.id_token || "";
    const accessToken = body.accessToken || body.access_token || body.google_token || "";
    if (!idToken && !accessToken) throw httpError(400, "idToken ou accessToken é obrigatório");
    const identity = await verifyGoogleToken({ idToken, accessToken });
    const result = await loginWithSocial({
      provider: "google",
      sub: identity.sub,
      email: identity.email,
      emailVerified: identity.emailVerified,
      name: identity.name || body.name || null,
      device: body.device
    });
    if (result.created) {
      notifySignup({
        name: identity.name || body.name,
        email: result.user.email,
        provider: "google"
      });
    }
    return ok(res, {
      created: result.created,
      message: result.message,
      data: await publicUser(result.user),
      ...result.tokens
    }, result.created ? 201 : 200);
  }

  if (req.method === "POST" && matchPath(pathname, "/api/auth/apple")) {
    limiter.consume("social", "social:" + limiter.clientIp(req));
    const body = await readJson(req);
    const identityToken = body.identityToken || body.identity_token || body.idToken || "";
    if (!identityToken) throw httpError(400, "identityToken é obrigatório");
    const identity = await verifyAppleIdentityToken(identityToken, body.nonce);
    const appleName = identity.name || appleNameFromBody(body) || null;
    const result = await loginWithSocial({
      provider: "apple",
      sub: identity.sub,
      email: identity.email,
      emailVerified: identity.emailVerified || Boolean(identity.email),
      name: appleName,
      device: body.device
    });
    if (result.created) {
      notifySignup({
        name: appleName,
        email: result.user.email,
        provider: "apple"
      });
    }
    return ok(res, {
      created: result.created,
      message: result.message,
      data: await publicUser(result.user),
      ...result.tokens
    }, result.created ? 201 : 200);
  }

  if (req.method === "POST" && matchPath(pathname, "/api/auth/refresh")) {
    limiter.consume("refresh", "refresh:" + limiter.clientIp(req));
    const body = await readJson(req);
    const tokens = await rotateRefresh(body.refreshToken, body.device);
    return ok(res, tokens);
  }

  if (req.method === "POST" && matchPath(pathname, "/api/auth/logout")) {
    const body = await readJson(req);
    await revokeRefresh(body.refreshToken);
    return ok(res, { loggedOut: true });
  }

  if (req.method === "GET" && matchPath(pathname, "/api/auth/me")) {
    const user = await requireUser(req);
    return ok(res, { data: await publicUser(user) });
  }

  if (req.method === "DELETE" && matchPath(pathname, "/api/auth/account")) {
    const user = await requireUser(req);
    const deleted = await deleteOwnAccount(user);
    return ok(res, { deleted: true, data: { id: deleted.id, status: deleted.status, deletedAt: deleted.deleted_at } });
  }

  return false;
}

module.exports = { handle };
