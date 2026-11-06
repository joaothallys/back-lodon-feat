const { log } = require("./logger");

const ORANGE = 0xff6a1a;

function clip(value) {
  const text = String(value || "").trim();
  return text ? text.slice(0, 200) : "—";
}

function visibleEmail(email) {
  const text = String(email || "").trim();
  if (!text || text.endsWith("@signin.londonfitness.local")) return "não informado";
  return text;
}

function entryLabel(provider) {
  if (provider === "google") return "Google";
  if (provider === "apple") return "Apple";
  return "E-mail";
}

function signupPayload(user) {
  const row = user || {};
  return {
    username: "LumenFit",
    embeds: [{
      title: "Novo usuário cadastrado",
      color: ORANGE,
      fields: [
        { name: "Nome", value: clip(row.name), inline: true },
        { name: "E-mail", value: clip(visibleEmail(row.email)), inline: true },
        { name: "Como entrou", value: entryLabel(row.provider), inline: true }
      ]
    }]
  };
}

function notifySignup(user) {
  const url = String(process.env.DISCORD_WEBHOOK_URL || "").trim();
  if (!url) return Promise.resolve(false);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(signupPayload(user)),
    signal: controller.signal
  }).then((res) => {
    if (!res.ok) log.warn("discord.signup", { status: res.status });
    return res.ok;
  }).catch((err) => {
    log.warn("discord.signup", { code: err && err.name });
    return false;
  }).finally(() => clearTimeout(timer));
}

module.exports = { signupPayload, notifySignup, visibleEmail };
