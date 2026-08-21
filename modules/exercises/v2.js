const { log } = require("../../lib/logger");
const repo = require("./repo");

const TIMEOUT_MS = 12000;

function configured() {
  return Boolean(process.env.RAPIDAPI_KEY);
}

function baseUrl() {
  return process.env.EXERCISEDB_V2_BASE_URL
    || "https://edb-with-videos-and-images-by-ascendapi.p.rapidapi.com/api/v1";
}

function host() {
  return process.env.EXERCISEDB_V2_HOST
    || "edb-with-videos-and-images-by-ascendapi.p.rapidapi.com";
}

function mapGender(value) {
  const raw = String(value || "").toLowerCase();
  if (raw === "mulher" || raw === "female" || raw === "f") return "female";
  return "male";
}

function itemGender(item) {
  return String(item && item.gender || "").toLowerCase();
}

async function request(path) {
  const key = process.env.RAPIDAPI_KEY;
  if (!key) {
    const err = new Error("exercisedb_v2_unconfigured");
    err.status = 503;
    throw err;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(baseUrl() + path, {
      signal: ctrl.signal,
      headers: {
        "X-RapidAPI-Key": key,
        "X-RapidAPI-Host": host(),
        Accept: "application/json"
      }
    });
  } catch (err) {
    log.error("exercisedb.v2.network", log.errFields(err));
    const fail = new Error("exercisedb_v2_unavailable");
    fail.status = 502;
    throw fail;
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 403) {
    const fail = new Error("exercisedb_v2_unsubscribed");
    fail.status = 503;
    throw fail;
  }
  if (res.status === 429) {
    const fail = new Error("exercisedb_v2_rate_limited");
    fail.status = 429;
    throw fail;
  }
  if (!res.ok) {
    log.error("exercisedb.v2.http", { status: res.status, path });
    const fail = new Error("exercisedb_v2_unavailable");
    fail.status = 502;
    throw fail;
  }
  return res.json();
}

function pickItem(items, gender) {
  const want = mapGender(gender);
  const exact = (items || []).find((item) => itemGender(item) === want);
  return { item: exact || (items && items[0]) || null, genderMatched: Boolean(exact) };
}

function mediaOf(item) {
  if (!item) return null;
  const images = item.imageUrls || {};
  return {
    exerciseId: item.exerciseId,
    name: item.name,
    gender: item.gender || null,
    imageUrl: item.imageUrl || images["720p"] || images["480p"] || images["360p"] || null,
    videoUrl: item.videoUrl || null,
    gifUrl: item.gifUrl || null,
    exerciseType: item.exerciseType || null,
    bodyParts: item.bodyParts || [],
    equipments: item.equipments || [],
    targetMuscles: item.targetMuscles || [],
    secondaryMuscles: item.secondaryMuscles || [],
    overview: item.overview || null,
    instructions: item.instructions || [],
    exerciseTips: item.exerciseTips || [],
    variations: item.variations || [],
    relatedExerciseIds: item.relatedExerciseIds || []
  };
}

async function listPath(path) {
  const json = await request(path);
  return (json && json.data) || [];
}

async function findMedia({ q, gender, exerciseId }) {
  const genderRequested = mapGender(gender);
  if (exerciseId) {
    const stored = repo.getV2Exercise(exerciseId);
    if (stored) {
      return {
        ...mediaOf(stored),
        genderRequested,
        genderMatched: false,
        fromCache: true
      };
    }
    const json = await request("/exercises/" + encodeURIComponent(exerciseId));
    const item = json && json.data;
    if (!item) return null;
    repo.upsertV2Exercise(item);
    return {
      ...mediaOf(item),
      genderRequested,
      genderMatched: !item.gender || itemGender(item) === genderRequested
    };
  }

  const name = String(q || "").trim();
  if (!name) return null;
  const stored = repo.findV2ExerciseByName(name);
  if (stored) {
    return {
      ...mediaOf(stored),
      genderRequested,
      genderMatched: false,
      fromCache: true
    };
  }

  const json = await request("/exercises?" + new URLSearchParams({ name, limit: "10" }).toString());
  const items = (json && json.data) || [];
  const picked = pickItem(items, genderRequested);
  if (!picked.item) return null;

  let full = picked.item;
  try {
    const detail = await request("/exercises/" + encodeURIComponent(picked.item.exerciseId));
    if (detail && detail.data) full = detail.data;
  } catch (err) {
    log.warn("exercisedb.v2.detail", log.errFields(err));
  }

  repo.upsertV2Exercise(full);
  const gendered = pickItem([full].concat(items), genderRequested);
  const chosen = gendered.item || full;
  return {
    ...mediaOf(chosen),
    genderRequested,
    genderMatched: gendered.genderMatched
  };
}

async function listMuscles() {
  return listPath("/muscles");
}

async function listBodyparts() {
  return listPath("/bodyparts");
}

async function listEquipments() {
  return listPath("/equipments");
}

async function listExerciseTypes() {
  return listPath("/exercisetypes");
}

module.exports = {
  configured,
  mapGender,
  findMedia,
  listMuscles,
  listBodyparts,
  listEquipments,
  listExerciseTypes
};
