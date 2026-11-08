import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { getConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
const base = {
  NODE_ENV: "development",
  MONGODB_URI: "mongodb://localhost/test",
  JWT_SECRET: "x".repeat(32),
};
const render = {
  ...base,
  RENDER: "true",
  RENDER_EXTERNAL_URL: "https://club.onrender.com",
};

test("Render uses its public URL when APP_URL is missing or localhost", () => {
  for (const APP_URL of [undefined, "", "http://localhost:3000"]) {
    const c = getConfig({ ...render, APP_URL });
    assert.equal(c.APP_URL, render.RENDER_EXTERNAL_URL);
    assert.deepEqual(c.ALLOWED_ORIGINS, [render.RENDER_EXTERNAL_URL]);
  }
  assert.equal(getConfig(base).TRUST_PROXY, false);
});

test("Render trusts only the nearest proxy even with development NODE_ENV", async () => {
  const app = createApp(getConfig(render));
  app.get("/test-ip", (req, res) => res.json({ ip: req.ip }));
  const res = await request(app)
    .get("/test-ip")
    .set("X-Forwarded-For", "198.51.100.5, 203.0.113.8");
  assert.equal(res.body.ip, "203.0.113.8");
});

test("normalized custom and Render origins pass; foreign origins and missing CSRF header fail", async () => {
  const c = getConfig({ ...render, APP_URL: " https://club.example/#/login " });
  assert.equal(c.APP_URL, "https://club.example");
  const app = createApp(c);
  for (const origin of ["https://club.example", render.RENDER_EXTERNAL_URL]) {
    const res = await request(app)
      .post("/api/unknown-route")
      .set("Origin", origin)
      .set("X-PMS-Request", "1");
    assert.equal(res.status, 401);
    assert.equal(res.headers["access-control-allow-origin"], origin);
  }
  const rejected = await request(app)
    .post("/api/unknown-route")
    .set("Origin", "https://attacker.example")
    .set("X-PMS-Request", "1");
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers["access-control-allow-origin"], undefined);
  const noHeader = await request(app)
    .post("/api/unknown-route")
    .set("Origin", render.RENDER_EXTERNAL_URL);
  assert.equal(noHeader.status, 403);
});

test("production validation remains enforced", () => {
  assert.throws(() => getConfig({ ...render, NODE_ENV: "production" }), /SMTP/);
  assert.throws(
    () => getConfig({ ...base, APP_URL: "ftp://example.com" }),
    /HTTP/,
  );
});
