const { test } = require("node:test");
const assert = require("node:assert/strict");
const { signupPayload, visibleEmail } = require("../lib/discord");

test("o aviso do Discord mostra nome, e-mail e como a pessoa entrou", () => {
  const payload = signupPayload({
    name: "João",
    email: "joao@exemplo.com",
    provider: "google"
  });
  const fields = payload.embeds[0].fields;
  assert.equal(payload.username, "LumenFit");
  assert.equal(payload.embeds[0].title, "Novo usuário cadastrado");
  assert.equal(fields[0].value, "João");
  assert.equal(fields[1].value, "joao@exemplo.com");
  assert.equal(fields[2].value, "Google");
});

test("cadastro da Apple sem e-mail não vaza o endereço interno", () => {
  assert.equal(visibleEmail("apple.abc@signin.londonfitness.local"), "não informado");
  const payload = signupPayload({ name: "", email: "apple.abc@signin.londonfitness.local", provider: "apple" });
  assert.equal(payload.embeds[0].fields[0].value, "—");
  assert.equal(payload.embeds[0].fields[1].value, "não informado");
  assert.equal(payload.embeds[0].fields[2].value, "Apple");
});
