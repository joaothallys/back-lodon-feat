const { one, pool } = require("../../db/pool");
const { ok, fail, readJson, required, matchPath, httpError } = require("../../lib/http");
const {
  hashPassword,
  verifyPassword,
  createSession,
  requireUser,
  publicUser,
  rotateRefresh,
  revokeRefresh,
  deleteOwnAccount,
  newMemberCode
} = require("../../lib/auth");

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

async function handle(req, res, url) {
  const pathname = url.pathname;

  if (req.method === "POST" && matchPath(pathname, "/api/auth/register")) {
    const body = await readJson(req);
    required(body, ["email", "password", "name"]);
    const email = String(body.email).trim().toLowerCase();
    const password = String(body.password);
    if (password.length < 6) throw httpError(400, "senha deve ter ao menos 6 caracteres");
    const exists = await one("SELECT id FROM users WHERE email = $1", [email]);
    if (exists) throw httpError(409, "e-mail já cadastrado");

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
    const valid = await verifyPassword(String(body.password), user.password_hash);
    if (!valid) throw httpError(401, "credenciais inválidas");
    await one("UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = $1 RETURNING id", [user.id]);
    const tokens = await createSession(user, body.device);
    return ok(res, { data: await publicUser(user), ...tokens });
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
