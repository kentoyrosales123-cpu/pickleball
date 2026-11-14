import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { mountLiveSession } from "../public/js/live-session.js";

test("session results show scores, changes, completed sessions and send score reports", async (t) => {
  const dom = new JSDOM("<main></main>");
  t.after(() => dom.window.close());
  const container = dom.window.document.querySelector("main");
  const result = {
    _id: "match",
    revision: 2,
    round: 1,
    court: "2",
    completedAt: new Date().toISOString(),
    won: true,
    scores: [
      { own: 11, opponent: 5 },
      { own: 11, opponent: 9 },
    ],
    partner: { fullName: "Partner <Name>" },
    opponents: [{ fullName: "One" }, { fullName: "Two" }],
    ratingChange: 12.345,
    starsChange: 2,
    reported: false,
  };
  const session = {
    event: {
      _id: "event",
      eventName: "Finished event",
      location: "Club",
      startDateTime: new Date().toISOString(),
    },
    status: "completed",
    games: 1,
    wins: 1,
    losses: 0,
    history: [result],
  };
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (options.method === "POST") {
      requests.push({ url, body: JSON.parse(options.body) });
      result.reported = true;
    }
    return { ok: true, json: async () => ({ sessions: [session] }) };
  });
  const originalSwal = globalThis.Swal;
  t.after(() => {
    globalThis.Swal = originalSwal;
  });
  globalThis.Swal = {
    fire: async (options) => {
      assert.equal(await options.preConfirm(""), false);
      assert.equal(
        await options.preConfirm("Correct score should be 11 to 7"),
        true,
      );
      return { isConfirmed: true };
    },
    showValidationMessage: () => {},
  };
  const state = {};
  const cleanup = await mountLiveSession(container, state);
  t.after(cleanup);
  assert.match(container.textContent, /1 games played · 1 wins · 0 losses/);
  assert.match(container.textContent, /Latest result: Win/);
  assert.match(container.textContent, /11–5, 11–9/);
  assert.match(container.textContent, /Rating points: \+12.35/);
  assert.match(container.textContent, /Stars: \+2/);
  assert.equal(container.querySelector("name"), null);
  assert.equal(container.querySelector("[data-availability]"), null);
  await container.querySelector("[data-report-score]").onclick();
  assert.deepEqual(requests, [
    {
      url: "/api/events/event/queue/matches/match/report-score",
      body: { reason: "Correct score should be 11 to 7", revision: 2 },
    },
  ]);
  assert.match(container.textContent, /Reported to organizer/);
  assert.equal(container.querySelector("[data-report-score]"), null);
  result.ratingHidden = true;
  result.ratingChange = null;
  await state.refreshLiveSession();
  assert.match(container.textContent, /Rating points: Hidden by club/);
});

test("player session view updates status, personal controls, match and court alert", async (t) => {
  const dom = new JSDOM("<main></main>");
  t.after(() => dom.window.close());
  const container = dom.window.document.querySelector("main");
  const state = {};
  const session = {
    event: {
      _id: "event",
      eventName: "Rally <Club>",
      location: "Courts",
      startDateTime: new Date().toISOString(),
    },
    status: "not-checked-in",
    games: 2,
    queuePosition: null,
    waitingCount: 5,
    waitingSince: null,
    match: null,
  };
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (options.method === "PUT") {
      requests.push({ url, status: JSON.parse(options.body).status });
      session.status =
        JSON.parse(options.body).status === "ready"
          ? "waiting"
          : JSON.parse(options.body).status;
      session.queuePosition = session.status === "waiting" ? 3 : null;
      session.waitingSince =
        session.status === "waiting"
          ? new Date(Date.now() - 65000).toISOString()
          : null;
    }
    return { ok: true, json: async () => ({ sessions: [session] }) };
  });
  const cleanup = await mountLiveSession(container, state);
  t.after(cleanup);
  assert.match(container.textContent, /My Live Session/);
  assert.equal(container.querySelector("club"), null);
  await container.querySelector('[data-availability="ready"]').onclick();
  assert.match(container.textContent, /3 \/ 5/);
  assert.match(
    container.querySelector("[data-waiting-since]").textContent,
    /1m 05s/,
  );
  await container.querySelector('[data-availability="break"]').onclick();
  assert.match(container.textContent, /Ready again/);
  assert.ok(
    requests.every((r) => r.url === "/api/events/event/queue/me/status"),
  );
  session.status = "up-next";
  session.match = {
    _id: "match",
    court: null,
    partner: { fullName: "Partner" },
    opponents: [{ fullName: "Opponent A" }, { fullName: "Opponent B" }],
  };
  await state.refreshLiveSession();
  assert.match(container.textContent, /Awaiting court assignment/);
  assert.match(container.textContent, /Partner/);
  assert.match(container.textContent, /Opponent A & Opponent B/);
  assert.equal(container.querySelector("[data-availability]"), null);
  session.status = "playing";
  session.match.court = "2";
  await state.refreshLiveSession();
  assert.match(
    container.querySelector(".notice[role=alert]").textContent,
    /called to Court 2/,
  );
  cleanup();
  assert.equal(state.refreshLiveSession, null);
});

test("player session view provides empty state and retry after a fetch failure", async (t) => {
  const dom = new JSDOM("<main></main>");
  t.after(() => dom.window.close());
  const container = dom.window.document.querySelector("main");
  let fail = true;
  t.mock.method(globalThis, "fetch", async () => {
    if (fail) throw new Error("Offline");
    return { ok: true, json: async () => ({ sessions: [] }) };
  });
  const cleanup = await mountLiveSession(container, {});
  t.after(cleanup);
  assert.match(container.textContent, /Offline/);
  fail = false;
  await container.querySelector("[data-session-refresh]").onclick();
  assert.match(container.textContent, /No active live sessions/);
  assert.equal(
    container.querySelector('a[href="#/events"]').textContent,
    "Explore events",
  );
});
