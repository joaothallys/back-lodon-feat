const { one, many, camel } = require("../../db/pool");
const { ok, readJson, matchPath, required, httpError } = require("../../lib/http");
const { requireUser, newMemberCode } = require("../../lib/auth");

function intervalDays(interval) {
  if (interval === "yearly") return 365;
  if (interval === "quarterly") return 90;
  return 30;
}

async function loadMembership(userId) {
  const membership = await one(
    `SELECT m.*,
            p.name AS plan_name, p.interval, p.amount, p.currency,
            u.name AS unit_name, u.address AS unit_address
     FROM memberships m
     JOIN membership_plans p ON p.id = m.plan_id
     LEFT JOIN gym_units u ON u.id = m.unit_id
     WHERE m.user_id = $1
     ORDER BY m.created_at DESC
     LIMIT 1`,
    [userId]
  );
  if (!membership) return null;
  const payments = await many(
    "SELECT * FROM payments WHERE membership_id = $1 ORDER BY due_date DESC",
    [membership.id]
  );
  return {
    ...camel(membership),
    plan: {
      id: membership.plan_id,
      name: membership.plan_name,
      interval: membership.interval,
      amount: membership.amount,
      currency: membership.currency
    },
    unit: membership.unit_id ? {
      id: membership.unit_id,
      name: membership.unit_name,
      address: membership.unit_address
    } : null,
    payments: camel(payments)
  };
}

async function handle(req, res, url) {
  const pathname = url.pathname;

  if (req.method === "GET" && matchPath(pathname, "/api/gym-units")) {
    await requireUser(req);
    return ok(res, { data: camel(await many("SELECT * FROM gym_units WHERE active = true ORDER BY name")) });
  }

  if (req.method === "GET" && matchPath(pathname, "/api/membership-plans")) {
    await requireUser(req);
    return ok(res, { data: camel(await many("SELECT * FROM membership_plans WHERE active = true ORDER BY amount")) });
  }

  if (req.method === "GET" && matchPath(pathname, "/api/membership")) {
    const user = await requireUser(req);
    const data = await loadMembership(user.id);
    if (!data) return ok(res, { data: null });
    return ok(res, { data });
  }

  if (req.method === "GET" && matchPath(pathname, "/api/membership/payments")) {
    const user = await requireUser(req);
    const rows = await many(
      "SELECT * FROM payments WHERE user_id = $1 ORDER BY due_date DESC",
      [user.id]
    );
    return ok(res, { data: camel(rows) });
  }

  if (req.method === "POST" && matchPath(pathname, "/api/membership")) {
    const user = await requireUser(req);
    const body = await readJson(req);
    required(body, ["planId"]);
    const plan = await one("SELECT * FROM membership_plans WHERE id = $1 AND active = true", [body.planId]);
    if (!plan) throw httpError(404, "plano não encontrado");
    if (body.unitId) {
      const unit = await one("SELECT id FROM gym_units WHERE id = $1 AND active = true", [body.unitId]);
      if (!unit) throw httpError(404, "unidade não encontrada");
    }
    const days = intervalDays(plan.interval);
    const next = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    let memberCode = body.memberCode || newMemberCode();
    const membership = await one(
      `INSERT INTO memberships (user_id, plan_id, unit_id, member_code, status, started_at, expires_at, next_payment_at)
       VALUES ($1, $2, $3, $4, 'ativa', CURRENT_DATE, $5, $5)
       RETURNING *`,
      [user.id, plan.id, body.unitId || null, memberCode, next]
    );
    await one(
      `INSERT INTO payments (membership_id, user_id, amount, due_date, status)
       VALUES ($1, $2, $3, $4, 'em_aberto') RETURNING id`,
      [membership.id, user.id, plan.amount, next]
    );
    return ok(res, { data: await loadMembership(user.id) }, 201);
  }

  if (req.method === "POST" && matchPath(pathname, "/api/membership/payments")) {
    const user = await requireUser(req);
    const body = await readJson(req);
    required(body, ["amount", "dueDate"]);
    const membership = await one(
      "SELECT * FROM memberships WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1",
      [user.id]
    );
    if (!membership) throw httpError(404, "matrícula não encontrada");
    const payment = await one(
      `INSERT INTO payments (membership_id, user_id, amount, due_date, paid_at, status, method)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        membership.id,
        user.id,
        body.amount,
        body.dueDate,
        body.paidAt || null,
        body.status || (body.paidAt ? "pago" : "em_aberto"),
        body.method || null
      ]
    );
    return ok(res, { data: camel(payment) }, 201);
  }

  const payParams = matchPath(pathname, "/api/membership/payments/:id");
  if (req.method === "PUT" && payParams) {
    const user = await requireUser(req);
    const body = await readJson(req);
    const current = await one(
      "SELECT * FROM payments WHERE id = $1 AND user_id = $2",
      [payParams.id, user.id]
    );
    if (!current) throw httpError(404, "pagamento não encontrado");
    const updated = await one(
      `UPDATE payments SET
         paid_at = COALESCE($1, paid_at),
         status = COALESCE($2, status),
         method = COALESCE($3, method)
       WHERE id = $4
       RETURNING *`,
      [body.paidAt || (body.status === "pago" ? new Date().toISOString().slice(0, 10) : null), body.status || null, body.method || null, payParams.id]
    );
    return ok(res, { data: camel(updated) });
  }

  return false;
}

module.exports = { handle };
