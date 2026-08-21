const v2 = require("../exercises/v2");
const repo = require("../exercises/repo");

async function loadExerciseMedia({ q, gender, exerciseId }) {
  const key = [exerciseId || "", String(q || "").trim().toLowerCase(), v2.mapGender(gender)].join("|");
  const cached = repo.getMediaV2(key);
  if (cached) return { ...cached, cached: true };
  const media = await v2.findMedia({ q, gender, exerciseId });
  if (!media) return null;
  repo.setMediaV2(key, media);
  return { ...media, cached: false };
}

async function loadTaxonomy(kind, fetcher) {
  const cached = repo.getV2Taxonomy(kind);
  if (cached) return { data: cached, cached: true };
  const data = await fetcher();
  repo.setV2Taxonomy(kind, data);
  return { data, cached: false };
}

async function loadMuscles() {
  return loadTaxonomy("muscles", v2.listMuscles);
}

async function loadBodyparts() {
  return loadTaxonomy("bodyparts", v2.listBodyparts);
}

async function loadEquipments() {
  return loadTaxonomy("equipments", v2.listEquipments);
}

async function loadExerciseTypes() {
  return loadTaxonomy("exercisetypes", v2.listExerciseTypes);
}

module.exports = {
  loadExerciseMedia,
  loadMuscles,
  loadBodyparts,
  loadEquipments,
  loadExerciseTypes
};
