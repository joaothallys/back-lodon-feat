const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const limiter = require("../lib/rate-limit");
const { matchPath } = require("../lib/http");

beforeEach(() => limiter.reset());

test("bloqueia ao passar do limite e informa quando tentar de novo", () => {
  for (let i = 0; i < 10; i += 1) limiter.consume("planGenerate", "plan:u1");
  assert.throws(() => limiter.consume("planGenerate", "plan:u1"), (err) => {
    assert.equal(err.status, 429);
    assert.ok(err.retryAfterSec > 0);
    return true;
  });
});

test("um usuário não consome o limite do outro", () => {
  for (let i = 0; i < 10; i += 1) limiter.consume("planGenerate", "plan:u1");
  assert.doesNotThrow(() => limiter.consume("planGenerate", "plan:u2"));
});

test("só falhas contam no login e o acerto zera o contador", () => {
  for (let i = 0; i < 7; i += 1) limiter.record("loginIpEmail", "login:ip:a@b.com");
  limiter.assertAllowed("loginIpEmail", "login:ip:a@b.com");
  limiter.clear("login:ip:a@b.com");
  for (let i = 0; i < 8; i += 1) limiter.record("loginIpEmail", "login:ip:a@b.com");
  assert.throws(() => limiter.assertAllowed("loginIpEmail", "login:ip:a@b.com"));
});

test("RATE_LIMIT_DISABLED desliga o bloqueio", () => {
  process.env.RATE_LIMIT_DISABLED = "true";
  try {
    for (let i = 0; i < 50; i += 1) limiter.consume("planGenerate", "plan:u3");
  } finally {
    delete process.env.RATE_LIMIT_DISABLED;
  }
});

test("usa o X-Real-IP do proxy, mesmo com X-Forwarded-For forjado", () => {
  const ip = limiter.clientIp({ headers: { "x-real-ip": "200.1.1.1", "x-forwarded-for": "6.6.6.6" }, socket: {} });
  assert.equal(ip, "200.1.1.1");
});

test("sem cabeçalhos de proxy usa o endereço do socket", () => {
  assert.equal(limiter.clientIp({ headers: {}, socket: { remoteAddress: "10.0.0.1" } }), "10.0.0.1");
});

test("URL malformada vira erro 400 em vez de 500", () => {
  assert.throws(() => matchPath("/api/shares/%E0%A4%A", "/api/shares/:id"), (err) => err.status === 400);
});
