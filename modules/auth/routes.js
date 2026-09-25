const { one, pool } = require("../../db/pool");
const { ok, readJson, required, matchPath, httpError } = require("../../lib/http");
const {
  hashPassword,
  verifyPassword,
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
const { verifyGoogleToken, verifyAppleIdentityToken, normalizeEmail } = require("../../lib/oauth");

function appleNameFromBody(body) {
  if (body.name) return String(body.name).trim();
  const full = body.fullName || body.full_name;
  if (!full || typeof full !== "object") return "";
  return [full.givenName, full.familyName].filter(Boolean).join(" ").trim();
}

async function handle(req, res, url) {
  const pathname = url.pathname;

  if (req.method === "POST" && matchPath(pathname, "/api/auth/register")) {
    const body = await readJson(req);
    required(body, ["email", "password", "name"]);
    const email = String(body.email).trim().toLowerCase();
    const password = String(body.password);
    if (password.length < 6) throw httpError(400, "senha deve ter ao menos 6 caracteres");
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
        [email, body.phone || null, passwordHash]
      )).rows[0];
      await client.query(
        `INSERT INTO user_profiles (user_id, name, gender, goal, level, environment, training_days, session_duration_min)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          user.id,
          String(body.name).trim(),
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
    const email = String(body.email).trim().toLowerCase();
    const user = await one("SELECT * FROM users WHERE email = $1", [email]);
    if (!user || user.status !== "active") throw httpError(401, "credenciais inválidas");
    if (!user.password_hash) throw httpError(401, "esta conta usa login social");
    const valid = await verifyPassword(String(body.password), user.password_hash);
    if (!valid) throw httpError(401, "credenciais inválidas");
    await one("UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = $1 RETURNING id", [user.id]);
    const tokens = await createSession(user, body.device);
    return ok(res, { data: await publicUser(user), ...tokens });
  }

  if (req.method === "POST" && matchPath(pathname, "/api/auth/google")) {
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
    return ok(res, {
      created: result.created,
      message: result.message,
      data: await publicUser(result.user),
      ...result.tokens
    }, result.created ? 201 : 200);
  }

  if (req.method === "POST" && matchPath(pathname, "/api/auth/apple")) {
    const body = await readJson(req);
    const identityToken = body.identityToken || body.identity_token || body.idToken || "";
    if (!identityToken) throw httpError(400, "identityToken é obrigatório");
    const identity = await verifyAppleIdentityToken(identityToken, body.nonce);
    const result = await loginWithSocial({
      provider: "apple",
      sub: identity.sub,
      email: identity.email || normalizeEmail(body.email),
      emailVerified: identity.emailVerified || Boolean(identity.email),
      name: identity.name || appleNameFromBody(body) || null,
      device: body.device
    });
    return ok(res, {
      created: result.created,
      message: result.message,
      data: await publicUser(result.user),
      ...result.tokens
    }, result.created ? 201 : 200);
  }

  if (req.method === "POST" && matchPath(pathname, "/api/auth/refresh")) {
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
