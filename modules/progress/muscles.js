const RULES = [
  ["peito", /(peito|supino|crucifixo|crossover|flexao|pec-deck|voador)/i],
  ["costas", /(costas|remada|puxada|pulldown|barra-fixa|pullover|terra|deadlift)/i],
  ["ombros", /(ombro|desenvolvimento|elevacao|arnold|crucifixo-invertido|face-pull)/i],
  ["biceps", /(biceps|rosca)/i],
  ["triceps", /(triceps|frances|testa|mergulho|corda|kickback)/i],
  ["pernas", /(perna|agachamento|afundo|hack|leg-press|extensora|flexora|passada|stiff|gluteo|cadeira-abdutora|cadeira-adutora)/i],
  ["panturrilha", /(panturrilha|gemeo|calf)/i],
  ["abdomen", /(abdomen|abdominal|prancha|crunch|obliquo|core)/i]
];

function muscleFromExerciseId(exerciseId) {
  const id = String(exerciseId || "");
  for (const [muscle, pattern] of RULES) {
    if (pattern.test(id)) return muscle;
  }
  return "outros";
}

function displayNameFromExerciseId(exerciseId) {
  const raw = String(exerciseId || "").replace(/[-_]+/g, " ").trim();
  if (!raw) return exerciseId;
  return raw.replace(/\b\w/g, (ch) => ch.toUpperCase());
}

module.exports = { muscleFromExerciseId, displayNameFromExerciseId };
