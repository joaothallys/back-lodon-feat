const { test } = require("node:test");
const assert = require("node:assert/strict");
const { sslConfig } = require("../db/pool");

const PEM = "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----";

test("com CA definido, exige a cadeia válida", () => {
  const ssl = sslConfig({ DATABASE_CA_CERT: PEM });
  assert.equal(ssl.rejectUnauthorized, true);
  assert.equal(ssl.ca, PEM);
});

test("aceita o CA em base64 e em PEM com \\n literal", () => {
  assert.equal(sslConfig({ DATABASE_CA_CERT: Buffer.from(PEM).toString("base64") }).ca, PEM);
  assert.equal(sslConfig({ DATABASE_CA_CERT: PEM.replace(/\n/g, "\\n") }).ca, PEM);
});

test("sem CA mantém a conexão atual, para o deploy não derrubar a API", () => {
  assert.equal(sslConfig({}).rejectUnauthorized, false);
});

test("DATABASE_SSL=false desliga o TLS", () => {
  assert.equal(sslConfig({ DATABASE_SSL: "false", DATABASE_CA_CERT: PEM }), false);
});
