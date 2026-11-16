import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import request from "supertest";
import { createApp } from "../src/app.js";

const app = createApp({
  NODE_ENV: "test",
  APP_URL: "http://localhost:3000",
  JWT_SECRET: "test-only-secret-".repeat(5),
});

test("PWA manifest, icons, service worker and offline page are served", async () => {
  const manifest = await request(app).get("/manifest.webmanifest");
  assert.equal(manifest.status, 200);
  assert.match(manifest.type, /manifest\+json/);
  assert.equal(manifest.headers["cache-control"], "no-cache");
  const data = JSON.parse(manifest.text);
  assert.equal(data.display, "standalone");
  assert.equal(data.short_name, "CourtSide");
  assert.ok(data.icons.some((i) => i.sizes === "512x512"));
  assert.ok(data.icons.some((i) => i.purpose === "maskable"));
  for (const icon of data.icons) {
    const res = await request(app).get(icon.src);
    assert.equal(res.status, 200, icon.src);
    assert.equal(res.type, "image/png");
  }

  const sw = await request(app).get("/sw.js");
  assert.equal(sw.status, 200);
  assert.match(sw.type, /javascript/);
  assert.equal(sw.headers["cache-control"], "no-cache");
  // The worker must never cache live data.
  assert.match(sw.text, /startsWith\("\/api\/"\)/);
  assert.match(sw.text, /startsWith\("\/socket\.io\/"\)/);

  const offline = await request(app).get("/offline.html");
  assert.equal(offline.status, 200);
  assert.match(offline.text, /You’re offline/);

  const index = await request(app).get("/");
  assert.match(index.text, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(index.text, /rel="apple-touch-icon"/);
});

test("every file the service worker pre-caches exists", async () => {
  const source = fs.readFileSync(
    new URL("../public/sw.js", import.meta.url),
    "utf8",
  );
  const shell = JSON.parse(
    source.match(/const SHELL = (\[[\s\S]*?\]);/)[1].replace(/,\s*\]/, "]"),
  );
  assert.ok(shell.length > 5);
  for (const url of shell) {
    const res = await request(app).get(url);
    assert.equal(res.status, 200, url);
  }
});
