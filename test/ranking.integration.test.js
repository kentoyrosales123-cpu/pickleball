import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import request from "supertest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { JSDOM } from "jsdom";
import { createApp } from "../src/app.js";
import {
  connectDatabase,
  User,
  Event,
  Team,
  Match,
  EventRegistration,
  AuditLog,
  Settings,
} from "../src/models/index.js";
import {
  PlayerRanking,
  RankingHistory,
  SeasonRanking,
  RankingAdjustment,
} from "../src/models/ranking.js";
import { migrateStarRanking } from "../src/migrations/002-star-ranking.js";
import { setSocket } from "../src/services/notifications.js";
import { RULES } from "../src/domain/ranking.js";
let repl,
  app,
  admin,
  token,
  n = 0;
const config = {
  NODE_ENV: "test",
  APP_URL: "http://localhost:3000",
  JWT_SECRET: "star-rank-test-secret".repeat(3),
};
const cookie = (u) =>
  `pms_session=${jwt.sign({ version: 0 }, config.JWT_SECRET, { subject: String(u._id), expiresIn: "1h", issuer: "pms", audience: "pms-web" })}`;
const call = (method, path, body, auth = token) => {
  const r = request(app)
    [method](`/api${path}`)
    .set("Cookie", auth)
    .set("X-PMS-Request", "1");
  return body === undefined ? r : r.send(body);
};
async function player(role = "player") {
  const i = ++n;
  return User.create({
    fullName: `Star player ${i}`,
    username: `star${i}`,
    email: `star${i}@example.test`,
    passwordHash: "test-only",
    provisionalRanking: 1,
    role,
  });
}
before(async () => {
  repl = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    binary: { version: "7.0.14", downloadDir: ".cache/mongodb-binaries" },
  });
  await connectDatabase(repl.getUri());
  app = createApp(config);
  admin = await player("admin");
  token = cookie(admin);
});
after(async () => {
  setSocket(null);
  await mongoose.disconnect();
  await repl?.stop();
});
async function fixture() {
  const players = await Promise.all(Array.from({ length: 4 }, () => player()));
  const now = Date.now();
  const event = await Event.create({
    eventName: `Ranked event ${n}`,
    eventType: "open-play",
    location: "Club",
    startDateTime: new Date(now - 86400000),
    endDateTime: new Date(now + 86400000),
    registrationOpen: new Date(now - 3 * 86400000),
    registrationDeadline: new Date(now - 2 * 86400000),
    capacity: 16,
    createdBy: admin._id,
    status: "ongoing",
    rated: true,
    format: "balanced",
  });
  await EventRegistration.insertMany(
    players.map((p) => ({
      eventId: event._id,
      userId: p._id,
      registrationStatus: "confirmed",
    })),
  );
  const teams = await Team.create(
    [0, 1].map((i) => ({
      eventId: event._id,
      generationBatchId: "stars",
      players: players.slice(i * 2, i * 2 + 2).map((p) => p._id),
      assignmentStatus: "finalized",
    })),
  );
  return { players, event, teams };
}
const match = (f) =>
  Match.create({
    eventId: f.event._id,
    teamA: f.teams[0]._id,
    teamB: f.teams[1]._id,
    rated: true,
    courtNumber: "1",
    roundNumber: 1,
  });
const finalize = (m, won = true, extra = {}) =>
  call("post", `/ranking/matches/${m._id}/finalize`, {
    scores: [won ? { a: 11, b: 5 } : { a: 5, b: 11 }],
    revision: 0,
    ...extra,
  });
const profile = (p) => PlayerRanking.findOne({ userId: p._id }).lean();
test("migration initializes Rookie profiles without replaying historical results", async () => {
  const f = await fixture(),
    m = await match(f);
  await Match.updateOne(
    { _id: m._id },
    {
      $set: {
        matchStatus: "finalized",
        winner: f.teams[0]._id,
        completedAt: new Date(),
        scores: [{ a: 11, b: 4 }],
      },
    },
  );
  await migrateStarRanking();
  assert.equal((await profile(f.players[0])).state.rankStars, 0);
  assert.equal(await RankingHistory.countDocuments({ matchId: m._id }), 0);
  assert.ok((await migrateStarRanking()).alreadyApplied);
});
test("duplicate finalization, concurrent shared players and post-commit private socket signals", async () => {
  const f = await fixture(),
    m = await match(f),
    emitted = [];
  setSocket({
    emit: (name) => emitted.push(name),
    to: (room) => ({
      emit: (name, payload) => emitted.push({ room, name, payload }),
    }),
  });
  const responses = await Promise.all([finalize(m), finalize(m)]);
  for (const r of responses)
    assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(await RankingHistory.countDocuments({ matchId: m._id }), 4);
  assert.equal((await profile(f.players[0])).state.rankStars, 1);
  assert.ok(
    emitted.some(
      (e) => e.name === "ranking:result" && e.room === String(f.players[0]._id),
    ),
  );
  assert.ok(!JSON.stringify(emitted).includes('"mmr"'));
  const [a, b] = await Promise.all([match(f), match(f)]);
  for (const r of await Promise.all([finalize(a), finalize(b)]))
    assert.equal(r.status, 200, JSON.stringify(r.body));
  const state = (await profile(f.players[0])).state;
  assert.equal(state.rankedMatches, 3);
  assert.equal(state.rankStars, 3);
  setSocket(null);
});
test("invalid scores, duplicate players and injected write errors roll back all effects", async () => {
  const f = await fixture(),
    m = await match(f);
  assert.equal(
    (await finalize(m, true, { scores: [{ a: 11, b: 10 }] })).status,
    400,
  );
  assert.equal((await Match.findById(m._id)).matchStatus, "scheduled");
  const original = RankingHistory.bulkWrite;
  const emitted = [];
  setSocket({
    emit: (name) => emitted.push(name),
    to: () => ({ emit: (name) => emitted.push(name) }),
  });
  RankingHistory.bulkWrite = async () => {
    throw new Error("Injected ranking write failure");
  };
  try {
    const failed = await finalize(m);
    assert.equal(failed.status, 500, JSON.stringify(failed.body));
  } finally {
    RankingHistory.bulkWrite = original;
    setSocket(null);
  }
  assert.equal((await Match.findById(m._id)).matchStatus, "scheduled");
  assert.equal(await RankingHistory.countDocuments({ matchId: m._id }), 0);
  assert.equal(emitted.length, 0);
  await Team.updateOne(
    { _id: f.teams[1]._id },
    { $set: { players: [f.players[0]._id, f.players[3]._id] } },
  );
  assert.equal((await finalize(m)).status, 500);
  assert.equal((await Match.findById(m._id)).matchStatus, "scheduled");
});
test("correction reverses meters, stars and downstream MMR with an audit trail", async () => {
  const f = await fixture(),
    m = await match(f);
  assert.equal((await finalize(m)).status, 200);
  const later = await match(f);
  assert.equal((await finalize(later)).status, 200);
  const before = (await profile(f.players[0])).state;
  const r = await call("post", `/ranking/matches/${m._id}/correct`, {
    scores: [{ a: 4, b: 11 }],
    revision: 1,
    reason: "Score sheet was reversed",
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = (await profile(f.players[0])).state;
  assert.equal(after.totalWins, 1);
  assert.equal(after.totalLosses, 1);
  assert.equal(after.rankStars, 1);
  assert.equal(after.doubleStarPoints, 20);
  assert.equal(after.protectionPoints, 20);
  assert.notEqual(before.mmr, after.mmr);
  assert.equal(await RankingHistory.countDocuments({ matchId: m._id }), 4);
  assert.ok(await AuditLog.exists({ action: "ranking-replay" }));
  assert.equal(
    (
      await call("post", `/ranking/matches/${m._id}/correct`, {
        scores: [{ a: 11, b: 4 }],
        revision: 1,
        reason: "Stale change",
      })
    ).status,
    409,
  );
  assert.equal((await finalize(m)).status, 409);
});
test("authorization, strict validation and hidden MMR across profile/history/statistics/leaderboard", async () => {
  const f = await fixture(),
    m = await match(f);
  await finalize(m);
  const c = cookie(f.players[0]);
  for (const [method, path, body] of [
    [
      "post",
      `/ranking/matches/${m._id}/finalize`,
      { scores: [{ a: 11, b: 4 }], revision: 0 },
    ],
    [
      "post",
      "/ranking/matchmaking/preview",
      {
        eventId: String(f.event._id),
        playerIds: f.players.map((p) => String(p._id)),
      },
    ],
    [
      "patch",
      `/admin/ranking/players/${f.players[0]._id}`,
      { rankStars: 99, reason: "Cheat" },
    ],
    ["patch", "/admin/ranking/settings", { showMMR: true, reason: "Cheat" }],
    ["post", "/admin/ranking/seasons", {}],
  ])
    assert.equal((await call(method, path, body, c)).status, 403);
  for (const path of [
    `/ranking/players/${f.players[0]._id}`,
    `/ranking/players/${f.players[0]._id}/history`,
    `/ranking/players/${f.players[0]._id}/statistics`,
    "/ranking/leaderboard",
  ]) {
    const r = await call("get", path, undefined, c);
    assert.equal(r.status, 200);
    assert.ok(
      !/"mmr"|"mmrChanged"|"expectedScore"/.test(JSON.stringify(r.body)),
    );
  }
  assert.equal(
    (
      await call("patch", `/admin/ranking/players/${f.players[0]._id}`, {
        rankStars: 20,
        mmr: 9999,
        reason: "Invalid field",
      })
    ).status,
    400,
  );
  assert.equal(
    (await call("get", "/ranking/players/invalid", undefined, c)).status,
    400,
  );
  await call("patch", "/admin/ranking/settings", {
    showMMR: true,
    reason: "Club transparency",
  });
  assert.equal(
    typeof (
      await call("get", `/ranking/players/${f.players[0]._id}`, undefined, c)
    ).body.profile.mmr,
    "number",
  );
  await call("patch", "/admin/ranking/settings", {
    showMMR: false,
    reason: "Private matchmaking",
  });
});
test("season transitions archive ranks, reset configured stars and preserve lifetime wins", async () => {
  const f = await fixture();
  await finalize(await match(f));
  await call("patch", `/admin/ranking/players/${f.players[0]._id}`, {
    rankStars: 30,
    reason: "Initial league placement",
  });
  const start = async (name, resetPolicy) =>
    call("post", "/admin/ranking/seasons", {
      name,
      endDate: new Date(Date.now() + 86400000).toISOString(),
      resetPolicy,
      keepFraction: 0.5,
      rankingRules: RULES,
      reason: "New competitive season",
    });
  const first = await start("First", "none");
  assert.equal(first.status, 201, JSON.stringify(first.body));
  await finalize(await match(f));
  const before = (await profile(f.players[0])).state;
  const second = await start("Second", "partial");
  assert.equal(second.status, 201, JSON.stringify(second.body));
  const after = (await profile(f.players[0])).state;
  assert.equal(after.rankStars, Math.floor(before.rankStars / 2));
  assert.equal(after.totalWins, before.totalWins);
  assert.equal(after.lifetimeStars, before.lifetimeStars);
  const snapshot = await SeasonRanking.findOne({
    playerId: f.players[0]._id,
    seasonId: first.body.season._id,
  });
  assert.equal(snapshot.state.rankStars, before.rankStars);
  const board = await call(
    "get",
    `/ranking/leaderboard?period=season&seasonId=${first.body.season._id}`,
  );
  assert.equal(board.status, 200);
  assert.equal(
    board.body.rows.find((p) => p.playerId === String(f.players[0]._id))
      .totalStars,
    before.rankStars,
  );
  const month = await call("get", "/ranking/leaderboard?period=month");
  assert.match(month.body.label, /Monthly net/);
  assert.ok(
    month.body.rows.find((p) => p.playerId === String(f.players[0]._id))
      .totalStars < 30,
  );
});
test("MMR matchmaking checks roster, avoids duplicate players, preserves tournament partners and saves drafts", async () => {
  const f = await fixture();
  await finalize(await match(f));
  const body = {
    eventId: String(f.event._id),
    playerIds: f.players.map((p) => String(p._id)),
    rotation: "least-played",
  };
  const preview = await call("post", "/ranking/matchmaking/preview", body);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.matches.length, 1);
  const teams = preview.body.matches.flatMap((m) => [m.teamA, m.teamB]);
  assert.equal(new Set(teams.flat()).size, 4);
  // A new unplayed event allows the existing draft/save/finalize workflow.
  const g = await fixture();
  const pre = await call("post", "/ranking/matchmaking/preview", {
    ...body,
    eventId: String(g.event._id),
    playerIds: g.players.map((p) => String(p._id)),
  });
  const save = await call("put", `/events/${g.event._id}/teams`, {
    teams: pre.body.matches.flatMap((m) => [m.teamA, m.teamB]),
  });
  assert.equal(save.status, 200, JSON.stringify(save.body));
  assert.equal(
    (
      await call("post", "/ranking/matchmaking/preview", {
        ...body,
        playerIds: [body.playerIds[0], ...body.playerIds.slice(0, 3)],
      })
    ).status,
    400,
  );
  await Event.updateOne(
    { _id: g.event._id },
    { $set: { eventType: "tournament", teamMode: "player-selected" } },
  );
  assert.equal(
    (
      await call("post", "/ranking/matchmaking/preview", {
        ...body,
        eventId: String(g.event._id),
        playerIds: g.players.map((p) => String(p._id)),
      })
    ).status,
    400,
  );
});
test("rank dashboard renders real API results and shows charts only when enabled", async () => {
  const f = await fixture();
  await finalize(await match(f));
  const dom = new JSDOM(
    '<main id="content"><div class="stats-grid"></div></main>',
    { url: "http://localhost:3000" },
  );
  const previous = { document: globalThis.document, fetch: globalThis.fetch };
  globalThis.document = dom.window.document;
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url).replace(/^\/api/, "");
    const r = await call(
      (options.method || "GET").toLowerCase(),
      path,
      options.body ? JSON.parse(options.body) : undefined,
      cookie(f.players[0]),
    );
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  try {
    const { mountStarRanking } = await import("../public/js/ranking.js");
    let charts = 0;
    await mountStarRanking(
      document.querySelector("main"),
      { id: String(f.players[0]._id) },
      () => charts++,
    );
    assert.match(document.body.textContent, /Rookie/);
    assert.equal(document.querySelectorAll("progress").length, 2);
    assert.equal(charts, 0);
    assert.ok(!document.querySelector("#star-mmr-chart"));
    await Settings.updateOne(
      { key: "global" },
      { $set: { showRankingMMR: true } },
    );
    await mountStarRanking(
      document.querySelector("main"),
      { id: String(f.players[0]._id) },
      () => charts++,
    );
    assert.equal(charts, 1);
  } finally {
    globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
    dom.window.close();
    await Settings.updateOne(
      { key: "global" },
      { $set: { showRankingMMR: false } },
    );
  }
});

test("ranked administrator page previews and saves teams through the existing event APIs", async () => {
  const f = await fixture();
  const dom = new JSDOM('<main id="content"></main>', {
    url: "http://localhost:3000",
  });
  const previous = {
    document: globalThis.document,
    fetch: globalThis.fetch,
    location: globalThis.location,
    Swal: globalThis.Swal,
  };
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.Swal = { fire: async () => ({ isConfirmed: false }) };
  globalThis.fetch = async (url, options = {}) => {
    const r = await call(
      (options.method || "GET").toLowerCase(),
      String(url).replace(/^\/api/, ""),
      options.body ? JSON.parse(options.body) : undefined,
    );
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  try {
    const { rankingPage } = await import("../public/js/ranking.js");
    await rankingPage(document.querySelector("main"), {
      id: String(admin._id),
      role: "admin",
    });
    assert.ok(document.querySelector("#rank-season-form"));
    const event = document.querySelector("#rank-operation-event");
    event.value = String(f.event._id);
    await event.onchange({ target: event });
    assert.equal(
      document.querySelectorAll("#rank-roster input:checked").length,
      4,
    );
    await document.querySelector("#rank-generate").onclick();
    assert.match(
      document.querySelector("#rank-preview").textContent,
      /Court 1/,
    );
    await document.querySelector("#rank-save-preview").onclick();
    assert.equal(
      await Team.countDocuments({
        eventId: f.event._id,
        assignmentStatus: "draft",
      }),
      2,
    );
  } finally {
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});

const reviewBody = (version = 0) => ({
  expectedVersion: version,
  targetRank: { tier: "Gold", division: "II", stars: 3 },
  stats: {
    profileUrl: "https://example.test/pickle-que/player/123",
    accountName: "External player",
    observedOn: new Date().toISOString().slice(0, 10),
    wins: 24,
    losses: 6,
    displayedRating: "Intermediate",
    notes: "Reviewed doubles results for this month",
  },
  reason: "Consistent results against experienced opponents",
  confirmed: true,
});
test("Pickle Que review records evidence, admin, computed stats and rank without changing MMR or match totals", async () => {
  const f = await fixture();
  await finalize(await match(f));
  const p = f.players[0],
    before = await profile(p),
    path = `/admin/ranking/players/${p._id}/pickle-que-review`;
  const saved = await call("post", path, reviewBody(before.version));
  assert.equal(saved.status, 201, JSON.stringify(saved.body));
  assert.equal(saved.body.rankStars, 53);
  const after = await profile(p);
  for (const key of [
    "mmr",
    "rankedMatches",
    "totalWins",
    "totalLosses",
    "protectionPoints",
    "doubleStarPoints",
    "lifetimeStars",
  ])
    assert.equal(after.state[key], before.state[key], key);
  const reviews = await call("get", path);
  assert.equal(reviews.body.total, 1);
  const row = reviews.body.reviews[0];
  assert.equal(row.actorId._id, String(admin._id));
  assert.equal(row.externalReview.matches, 30);
  assert.equal(row.externalReview.winPercentage, 80);
  assert.equal(row.externalReview.previousRankStars, before.state.rankStars);
  assert.equal(row.externalReview.entryMethod, "admin-entered");
  assert.ok(
    await AuditLog.exists({
      action: "pickle-que-rank-review",
      entityId: String(p._id),
    }),
  );
  const history = await call(
    "get",
    `/ranking/players/${p._id}/history`,
    undefined,
    cookie(p),
  );
  assert.ok(!JSON.stringify(history.body).includes("example.test/pickle-que"));
  await finalize(await match(f));
  assert.equal((await profile(p)).state.rankStars, 54);
  assert.equal(
    await RankingAdjustment.countDocuments({
      playerId: p._id,
      "externalReview.source": "pickle-que",
    }),
    1,
  );
});
test("Pickle Que endpoints reject ordinary users, invalid evidence, unconfirmed changes and rank/MMR injection", async () => {
  const p = await player(),
    path = `/admin/ranking/players/${p._id}/pickle-que-review`,
    body = reviewBody();
  assert.equal((await call("get", path, undefined, cookie(p))).status, 403);
  assert.equal((await call("post", path, body, cookie(p))).status, 403);
  for (const change of [
    { confirmed: false },
    { reason: "" },
    { mmr: 9000 },
    { rankStars: 400 },
    { stats: { ...body.stats, wins: -1 } },
    { stats: { ...body.stats, wins: 1.2 } },
    { stats: { ...body.stats, wins: 0, losses: 0 } },
    { stats: { ...body.stats, profileUrl: "not a URL" } },
    { stats: { ...body.stats, profileUrl: "javascript:alert(1)" } },
    {
      stats: {
        ...body.stats,
        profileUrl: "https://user:password@example.test/",
      },
    },
    { stats: { ...body.stats, observedOn: "2999-01-01" } },
    { stats: { ...body.stats, winPercentage: 99 } },
    { targetRank: { tier: "Gold", division: "III", stars: 5 } },
    { targetRank: { tier: "Legend", division: "I", stars: 10 } },
  ])
    assert.equal(
      (await call("post", path, { ...body, ...change })).status,
      400,
      JSON.stringify(change),
    );
  assert.equal(await RankingAdjustment.countDocuments({ playerId: p._id }), 0);
});
test("concurrent Pickle Que reviews accept one version and reject stale/duplicate saves; Legend converts correctly", async () => {
  const p = await player(),
    path = `/admin/ranking/players/${p._id}/pickle-que-review`,
    body = reviewBody();
  const results = await Promise.all([
    call("post", path, body),
    call("post", path, body),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  const current = await profile(p);
  const legend = await call("post", path, {
    ...body,
    expectedVersion: current.version,
    targetRank: { tier: "Legend", division: null, stars: 12 },
  });
  assert.equal(legend.status, 201, JSON.stringify(legend.body));
  assert.equal(legend.body.rankStars, 147);
  assert.equal((await call("get", `${path}?page=2`)).body.reviews.length, 0);
});
test("Pickle Que review form calculates win rate, previews rank and saves through the real API", async () => {
  const p = await player();
  const dom = new JSDOM("<main></main>", { url: "http://localhost:3000" });
  const previous = {
    document: globalThis.document,
    fetch: globalThis.fetch,
    Swal: globalThis.Swal,
  };
  globalThis.document = dom.window.document;
  globalThis.fetch = async (url, options = {}) => {
    const r = await call(
      (options.method || "GET").toLowerCase(),
      String(url).replace(/^\/api/, ""),
      options.body ? JSON.parse(options.body) : undefined,
    );
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  let confirmations = 0;
  globalThis.Swal = {
    showValidationMessage: (message) => assert.fail(message),
    fire: async (options) => {
      if (options.toast) return {};
      if (options.html) {
        document.body.innerHTML = options.html;
        options.didOpen();
        const f = document.querySelector("#pq-review-form"),
          body = reviewBody();
        for (const [key, value] of Object.entries(body.stats))
          f.elements[key].value = value;
        f.elements.tier.value = "Gold";
        f.elements.division.value = "II";
        f.elements.stars.value = "3";
        f.elements.reason.value = body.reason;
        f.elements.confirmed.checked = true;
        f.oninput();
        assert.match(
          document.querySelector("#pq-stat-summary").textContent,
          /80.0%/,
        );
        assert.match(
          document.querySelector("#pq-rank-summary").textContent,
          /53 total stars/,
        );
        return { isConfirmed: true, value: options.preConfirm() };
      }
      confirmations++;
      assert.match(options.text, /Gold II/);
      return { isConfirmed: true };
    },
  };
  try {
    const { reviewPickleQue } = await import("../public/js/pickle-que.js");
    assert.equal(await reviewPickleQue(String(p._id)), true);
    assert.equal(confirmations, 1);
    assert.equal((await profile(p)).state.rankStars, 53);
  } finally {
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});
