const { one, many, camel } = require("../../db/pool");
const { ok, matchPath } = require("../../lib/http");
const { requireUser } = require("../../lib/auth");

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

  return false;
}

module.exports = { handle };
