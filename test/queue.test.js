import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { renderQueue, waitingDuration } from "../public/js/queue.js";

test("queue availability controls check in, pause, return and leave without unregistering", async (t) => {
  const dom = new JSDOM("<main></main>");
  t.after(() => dom.window.close());
  const container = dom.window.document.querySelector("main");
  const player = {
    _id: "p1",
    fullName: "Player <One>",
    games: 3,
    wins: 1,
    lastResult: "L",
    queueStatus: "not-checked-in",
    waitingSince: new Date().toISOString(),
  };
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (options.method === "PUT") {
      requests.push({ url, status: JSON.parse(options.body).status });
      player.queueStatus = JSON.parse(options.body).status;
    }
    return {
      ok: true,
      json: async () => ({
        waiting: player.queueStatus === "ready" ? [player] : [],
        unavailable: player.queueStatus === "ready" ? [] : [player],
        live: [],
        next: [],
        completed: 3,
      }),
    };
  });
  const event = { _id: "event", courts: ["1"], status: "registration-open" };
  await renderQueue(container, event, () => {});
  assert.equal(
    container.querySelector('[data-player-status="ready"]').textContent,
    "Check in",
  );
  assert.equal(container.querySelector("one"), null);
  for (const status of ["ready", "break", "ready", "left"]) {
    await container.querySelector(`[data-player-status="${status}"]`).onclick();
    if (status === "break")
      assert.equal(
        container.querySelector('[data-player-status="ready"]').textContent,
        "Ready again",
      );
  }
  assert.deepEqual(
    requests.map((r) => r.status),
    ["ready", "break", "ready", "left"],
  );
  assert.ok(
    requests.every(
      (r) => r.url === "/api/events/event/queue/players/p1/status",
    ),
  );
  assert.match(container.textContent, /Left session.*3 games/);
  await renderQueue(container, { ...event, status: "completed" }, () => {});
  assert.ok(container.querySelector('[data-player-status="ready"]').disabled);
});

test("queue wait duration handles seconds, hours and future timestamps", () => {
  const start = "2026-11-13T10:00:00.000Z";
  const now = +new Date(start);
  assert.equal(waitingDuration(start, now), "0m 00s");
  assert.equal(waitingDuration(start, now + 65_000), "1m 05s");
  assert.equal(waitingDuration(start, now + 3_665_000), "1h 1m 05s");
  assert.equal(waitingDuration(start, now + 90_000_000), "25h 0m 00s");
  assert.equal(waitingDuration(start, now - 1000), "0m 00s");
});

test("live queue updates waiting time and stops its timer on refresh and removal", async (t) => {
  const dom = new JSDOM("<main></main>");
  t.after(() => dom.window.close());
  const container = dom.window.document.querySelector("main");
  let now = Date.parse("2026-11-13T10:00:00Z");
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => ({
      waiting: [
        {
          _id: "player",
          fullName: "Player",
          games: 2,
          wins: 1,
          lastResult: "W",
          waitingSince: new Date(now - 65_000).toISOString(),
        },
      ],
      live: [],
      next: [],
      completed: 2,
    }),
  }));
  let tick;
  t.mock.method(dom.window, "setInterval", (fn) => {
    tick = fn;
    return 1;
  });
  const clear = t.mock.method(dom.window, "clearInterval", () => {});
  const event = { _id: "event", courts: ["1"], status: "ongoing" };
  await renderQueue(container, event, () => {});
  assert.match(
    container.querySelector("li small").textContent,
    /2 games.*Waiting 1m 05s/,
  );
  now += 1000;
  tick();
  assert.match(
    container.querySelector("li small").textContent,
    /Waiting 1m 06s/,
  );
  await renderQueue(container, event, () => {});
  assert.equal(clear.mock.callCount(), 1);
  container.remove();
  tick();
  assert.equal(clear.mock.callCount(), 2);
});
