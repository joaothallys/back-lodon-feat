const { one, many, camel, pool } = require("../../db/pool");
const { ok, readJson, matchPath, required, httpError } = require("../../lib/http");
const { requireUser } = require("../../lib/auth");

async function withEquipment(location) {
  const items = await many(
    "SELECT equipment_id FROM user_location_equipment WHERE location_id = $1",
    [location.id]
  );
  return { ...camel(location), equipment: items.map((row) => row.equipment_id) };
}

async function setEquipment(locationId, equipment) {
  await one("DELETE FROM user_location_equipment WHERE location_id = $1 RETURNING location_id", [locationId]);
  const items = Array.isArray(equipment) ? equipment : [];
  for (const item of items) {
    await one(
      "INSERT INTO user_location_equipment (location_id, equipment_id) VALUES ($1, $2) RETURNING location_id",
      [locationId, String(item)]
    );
  }
}

async function handle(req, res, url) {
  const pathname = url.pathname;

  if (req.method === "GET" && matchPath(pathname, "/api/locations")) {
    const user = await requireUser(req);
    const rows = await many(
      "SELECT * FROM user_locations WHERE user_id = $1 ORDER BY created_at DESC",
      [user.id]
    );
    const data = [];
    for (const row of rows) data.push(await withEquipment(row));
    return ok(res, { data });
  }

  if (req.method === "POST" && matchPath(pathname, "/api/locations")) {
    const user = await requireUser(req);
    const body = await readJson(req);
    required(body, ["name", "type"]);
    if (body.type !== "gym" && body.type !== "home") throw httpError(400, "type deve ser gym ou home");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (body.isActive) {
        await client.query("UPDATE user_locations SET is_active = false WHERE user_id = $1", [user.id]);
      }
      const location = (await client.query(
        `INSERT INTO user_locations (user_id, name, type, is_active)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [user.id, body.name, body.type, Boolean(body.isActive)]
      )).rows[0];
      await client.query("COMMIT");
      if (body.equipment) await setEquipment(location.id, body.equipment);
      return ok(res, { data: await withEquipment(location) }, 201);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  const activate = matchPath(pathname, "/api/locations/:id/activate");
  if (req.method === "PUT" && activate) {
    const user = await requireUser(req);
    const location = await one(
      "SELECT * FROM user_locations WHERE id = $1 AND user_id = $2",
      [activate.id, user.id]
    );
    if (!location) throw httpError(404, "local não encontrado");
    await one("UPDATE user_locations SET is_active = false, updated_at = now() WHERE user_id = $1 RETURNING id", [user.id]);
    const updated = await one(
      "UPDATE user_locations SET is_active = true, updated_at = now() WHERE id = $1 RETURNING *",
      [location.id]
    );
    return ok(res, { data: await withEquipment(updated) });
  }

  const equip = matchPath(pathname, "/api/locations/:id/equipment");
  if (req.method === "PUT" && equip) {
    const user = await requireUser(req);
    const body = await readJson(req);
    const location = await one(
      "SELECT * FROM user_locations WHERE id = $1 AND user_id = $2",
      [equip.id, user.id]
    );
    if (!location) throw httpError(404, "local não encontrado");
    await setEquipment(location.id, body.equipment || body.items || []);
    return ok(res, { data: await withEquipment(location) });
  }

  const oneLoc = matchPath(pathname, "/api/locations/:id");
  if (req.method === "PUT" && oneLoc) {
    const user = await requireUser(req);
    const body = await readJson(req);
    const location = await one(
      "SELECT * FROM user_locations WHERE id = $1 AND user_id = $2",
      [oneLoc.id, user.id]
    );
    if (!location) throw httpError(404, "local não encontrado");
    const updated = await one(
      `UPDATE user_locations SET
         name = COALESCE($1, name),
         type = COALESCE($2, type),
         updated_at = now()
       WHERE id = $3
       RETURNING *`,
      [body.name || null, body.type || null, location.id]
    );
    if (body.equipment) await setEquipment(updated.id, body.equipment);
    return ok(res, { data: await withEquipment(updated) });
  }

  if (req.method === "DELETE" && oneLoc) {
    const user = await requireUser(req);
    const deleted = await one(
      "DELETE FROM user_locations WHERE id = $1 AND user_id = $2 RETURNING id",
      [oneLoc.id, user.id]
    );
    if (!deleted) throw httpError(404, "local não encontrado");
    return ok(res, { deleted: true });
  }

  return false;
}

module.exports = { handle };
