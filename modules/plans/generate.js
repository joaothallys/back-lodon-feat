const { completeJson } = require("./groq");
const catalogRepo = require("../catalog/repo");
const { one, many } = require("../../db/pool");
const { httpError } = require("../../lib/http");
const { log } = require("../../lib/logger");

const LETTERS = ["A", "B", "C", "D", "E", "F"];
const GOALS = ["hipertrofia", "forca", "emagrecimento", "definicao"];
const LEVELS = ["iniciante", "intermediario", "avancado"];
const ENVIRONMENTS = ["academia", "casa", "peso-corporal"];
const EQUIPMENT = ["halteres", "barra", "polia", "maquina", "banco", "elastico", "kettlebell", "peso-corporal"];
const FOCUS = ["peito", "costas", "ombros", "biceps", "triceps", "pernas", "gluteos", "abdomen", "corpo-inteiro"];
const HARD_IDS = new Set([
  "muscle-up",
  "paralelas",
  "burpee-com-salto",
  "flexao-braco-unilateral",
  "flexao-braco-palmas",
  "flexao-braco-rotacao-tronco",
  "handstand-push-up"
]);

function restDefault(goal, level) {
  if (goal === "forca") return level === "avancado" ? 120 : 90;
  if (goal === "emagrecimento") return 45;
  if (level === "iniciante") return 60;
  return 75;
}

function setsReps(goal, level, gender) {
  let sets = 3;
  let reps = 10;
  if (goal === "forca") {
    sets = 4;
    reps = 6;
  } else if (goal === "emagrecimento" || goal === "definicao") {
    sets = 3;
    reps = 12;
  } else if (level === "avancado") {
    sets = 4;
    reps = 8;
  }
  if (gender === "mulher") reps += 2;
  return { sets, reps };
}

function targetCount(level) {
  if (level === "iniciante") return 5;
  if (level === "avancado") return 7;
  return 6;
}

function mapGender(value, profile) {
  const raw = String(value || profile && profile.gender || "").toLowerCase();
  if (raw === "homem" || raw === "male") return "homem";
  if (raw === "mulher" || raw === "female") return "mulher";
  return "homem";
}

function pickEnum(value, allowed, fallback) {
  const raw = String(value || "").toLowerCase();
  return allowed.includes(raw) ? raw : fallback;
}

function pickList(values, allowed) {
  if (!Array.isArray(values)) return [];
  return values.map((item) => String(item).toLowerCase()).filter((item) => allowed.includes(item));
}

function gymPriority(equipmentId) {
  return ["maquina", "polia", "halteres", "barra"].indexOf(equipmentId);
}

function scoreExercise(row, ctx) {
  let score = Number(row.popularity || 0);
  if (ctx.equipment.includes(row.equipment_id) || (row.equipment_id === "smith" && ctx.equipment.includes("maquina"))) {
    score += 40;
  }
  if (ctx.environment === "academia" && gymPriority(row.equipment_id) >= 0) score += 20 - gymPriority(row.equipment_id) * 3;
  if (ctx.environment === "casa" && (row.equipment_id === "halteres" || row.equipment_id === "elastico" || row.equipment_id === "peso-corporal")) score += 25;
  if (ctx.environment === "peso-corporal" && row.equipment_id === "peso-corporal") score += 30;
  if (ctx.level === "iniciante" && row.level === "avancado") score -= 80;
  if (ctx.gender === "mulher" && HARD_IDS.has(row.id)) score -= 100;
  if (ctx.level === "iniciante" && HARD_IDS.has(row.id)) score -= 100;
  return score;
}

function allowedForStudent(row, ctx) {
  if (ctx.level === "iniciante" && row.level === "avancado") return false;
  if (ctx.level === "iniciante" && HARD_IDS.has(row.id)) return false;
  if (ctx.gender === "mulher" && HARD_IDS.has(row.id)) return false;
  return true;
}

function splitFor(daysPerWeek, muscles) {
  const pool = muscles.length ? muscles : ["peito", "costas", "ombros", "biceps"];
  const names = {
    peito: "Peito",
    costas: "Costas",
    ombros: "Ombros",
    biceps: "Bíceps",
    triceps: "Tríceps",
    pernas: "Pernas",
    gluteos: "Glúteos",
    abdomen: "Abdômen"
  };
  if (daysPerWeek <= pool.length) {
    return pool.slice(0, daysPerWeek).map((muscle, index) => ({
      name: LETTERS[index] + " · " + (names[muscle] || muscle),
      focus: [muscle]
    }));
  }
  const days = [];
  for (let i = 0; i < daysPerWeek; i += 1) {
    const a = pool[i % pool.length];
    const b = pool[(i + 1) % pool.length];
    days.push({
      name: LETTERS[i] + " · " + (names[a] || a) + (a !== b ? " e " + (names[b] || b).toLowerCase() : ""),
      focus: a === b ? [a] : [a, b]
    });
  }
  return days;
}

function fillDay(day, catalog, ctx, usedGlobal, minCount) {
  const seen = new Set((day.exercises || []).map((item) => item.exerciseId));
  const focus = (day.focus || []).filter(Boolean);
  const pool = catalog
    .filter((row) => allowedForStudent(row, ctx))
    .filter((row) => !focus.length || focus.includes(row.muscle_id))
    .sort((a, b) => scoreExercise(b, ctx) - scoreExercise(a, ctx));

  const extras = catalog
    .filter((row) => allowedForStudent(row, ctx))
    .sort((a, b) => scoreExercise(b, ctx) - scoreExercise(a, ctx));

  const defaults = setsReps(ctx.goal, ctx.level, ctx.gender);
  const rest = restDefault(ctx.goal, ctx.level);
  const out = (day.exercises || []).slice();

  function push(row) {
    if (!row || seen.has(row.id)) return;
    seen.add(row.id);
    usedGlobal.add(row.id);
    out.push({
      exerciseId: row.id,
      sets: defaults.sets,
      reps: defaults.reps,
      kg: 0,
      restSec: rest
    });
  }

  for (const row of pool) {
    if (out.length >= minCount) break;
    push(row);
  }
  for (const row of extras) {
    if (out.length >= minCount) break;
    push(row);
  }
  return { ...day, exercises: out };
}

function sanitizePlan(raw, catalog, ctx) {
  const byId = new Map(catalog.map((row) => [row.id, row]));
  const availableMuscles = [...new Set(catalog.map((row) => row.muscle_id))];
  const daysPerWeek = ctx.daysPerWeek;
  const minCount = 4;
  const want = targetCount(ctx.level);
  const used = new Set();

  let days = Array.isArray(raw && raw.days) ? raw.days : [];
  days = days.slice(0, daysPerWeek).map((day, index) => {
    const focus = (day.focus || []).filter((muscle) => availableMuscles.includes(muscle));
    const exercises = [];
    (day.exercises || []).forEach((item) => {
      const id = item && (item.exerciseId || item.id);
      const row = byId.get(id);
      if (!row || !allowedForStudent(row, ctx)) return;
      if (exercises.some((ex) => ex.exerciseId === row.id)) return;
      used.add(row.id);
      exercises.push({
        exerciseId: row.id,
        sets: Number(item.sets) || setsReps(ctx.goal, ctx.level, ctx.gender).sets,
        reps: Number(item.reps) || setsReps(ctx.goal, ctx.level, ctx.gender).reps,
        kg: 0,
        restSec: Number(item.restSec) || restDefault(ctx.goal, ctx.level)
      });
    });
    return {
      name: day.name || LETTERS[index] + " · Dia " + (index + 1),
      focus: focus.length ? focus : [availableMuscles[index % availableMuscles.length]],
      exercises
    };
  });

  const skeleton = splitFor(daysPerWeek, availableMuscles);
  while (days.length < daysPerWeek) {
    days.push({ name: skeleton[days.length].name, focus: skeleton[days.length].focus, exercises: [] });
  }

  days = days.map((day, index) => {
    const filled = fillDay(day, catalog, ctx, used, Math.max(minCount, want));
    if (!filled.name) filled.name = skeleton[index].name;
    return filled;
  });

  const name = (raw && raw.name) || ctx.name || ("Plano " + ctx.goal + " · " + daysPerWeek + " dias");
  return { name, days };
}

function buildPrompt(ctx, catalogText) {
  const system = [
    "Você é o treinador da Academia London Fitness (Brasil).",
    "Monta fichas só com aparelhos e nomes desta academia.",
    "Responda APENAS um JSON válido, sem markdown, sem texto fora do JSON."
  ].join("\n");

  const user = [
    "Perfil do aluno:",
    "- sexo: " + ctx.gender,
    "- objetivo: " + ctx.goal,
    "- nível: " + ctx.level,
    "- local: " + ctx.environment,
    "- dias por semana: " + ctx.daysPerWeek,
    "- duração da sessão: " + ctx.sessionDurationMin + " min",
    "- equipamentos: " + (ctx.equipment.join(", ") || "academia"),
    "- foco: " + (ctx.focus.join(", ") || "corpo-inteiro"),
    "",
    "CATÁLOGO OFICIAL (use SOMENTE estes exerciseId; é proibido inventar, traduzir ou usar nome em inglês/ExerciseDB):",
    catalogText,
    "",
    "Tarefa:",
    "Crie um plano com exatamente " + ctx.daysPerWeek + " dias.",
    "Cada dia: 5 a 8 exercícios, sem repetir o mesmo exerciseId no mesmo dia.",
    "Prefira equipamentos que o aluno tem. Se environment=academia, priorize maquina, polia, halteres, barra.",
    "Não use exercício de nível avancado para iniciante.",
    "Se o catálogo não tiver perna/tríceps, monte o split só com peito, costas, ombros e bíceps (não invente agachamento).",
    "JSON de saída, neste schema e nada mais:",
    JSON.stringify({
      name: "string",
      days: [
        {
          name: "A · Peito",
          focus: ["peito"],
          exercises: [{ exerciseId: "id-do-catalogo", sets: 3, reps: 10, kg: 0, restSec: 75 }]
        }
      ]
    })
  ].join("\n");

  return { system, user };
}

async function buildContext(user, body) {
  const profile = await one("SELECT * FROM user_profiles WHERE user_id = $1", [user.id]);
  const extras = {
    equipment: (await many("SELECT equipment_id FROM user_profile_equipment WHERE user_id = $1", [user.id]))
      .map((row) => row.equipment_id),
    focus: (await many("SELECT muscle_id FROM user_profile_focus WHERE user_id = $1", [user.id]))
      .map((row) => row.muscle_id)
  };

  const daysPerWeek = Number(body.daysPerWeek || (profile && profile.training_days) || 4);
  if (daysPerWeek < 3 || daysPerWeek > 6) throw httpError(400, "daysPerWeek deve ser 3 a 6");

  const focus = pickList(body.focus && body.focus.length ? body.focus : extras.focus, FOCUS);
  const whole = !focus.length || focus.includes("corpo-inteiro");

  return {
    name: body.name || null,
    gender: mapGender(body.gender, profile),
    goal: pickEnum(body.goal || (profile && profile.goal), GOALS, "hipertrofia"),
    level: pickEnum(body.level || (profile && profile.level), LEVELS, "intermediario"),
    environment: pickEnum(body.environment || (profile && profile.environment), ENVIRONMENTS, "academia"),
    daysPerWeek,
    sessionDurationMin: Number(body.sessionDurationMin || (profile && profile.session_duration_min) || 60),
    equipment: pickList(body.equipment && body.equipment.length ? body.equipment : extras.equipment, EQUIPMENT),
    focus: whole ? [] : focus.filter((item) => item !== "corpo-inteiro"),
    source: "ia"
  };
}

async function generateFromAi(user, body) {
  const ctx = await buildContext(user, body);
  const catalog = await catalogRepo.listActive();
  if (!catalog.length) {
    log.error("plan.catalog_empty", { userId: user.id });
    throw httpError(500, "catálogo London vazio");
  }

  const availableMuscles = [...new Set(catalog.map((row) => row.muscle_id))];
  if (ctx.focus.length) {
    ctx.focus = ctx.focus.filter((muscle) => availableMuscles.includes(muscle));
  }

  log.info("plan.generate.start", {
    userId: user.id,
    goal: ctx.goal,
    level: ctx.level,
    daysPerWeek: ctx.daysPerWeek,
    catalog: catalog.length
  });

  let raw;
  try {
    raw = await completeJson(buildPrompt(ctx, catalogRepo.promptLines(catalog)));
  } catch (err) {
    log.error("plan.generate.ia", { userId: user.id, ...log.errFields(err) });
    if (err.status === 502) throw err;
    throw httpError(502, "ia_unavailable");
  }

  const plan = sanitizePlan(raw, catalog, ctx);
  log.info("plan.generate.ok", {
    userId: user.id,
    name: plan.name,
    days: plan.days.length,
    exercises: plan.days.reduce((sum, day) => sum + (day.exercises || []).length, 0)
  });
  return { ctx, plan };
}

module.exports = { generateFromAi };
