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
  PlayerRating,
  RatingHistory,
  RatingOverride,
  Settings,
  Notification,
  AuditLog,
} from "../src/models/index.js";
import {
  DEFAULT_RATING_POLICY,
  replayRatings,
  seedRating,
} from "../src/domain/ratings.js";
import { migrateRatings } from "../src/migrations/001-doubles-ratings.js";
import { lockRatings } from "../src/services/ratings.js";
let repl,
  app,
  admin,
  adminCookie,
  index = 0;
const config = {
  NODE_ENV: "test",
  APP_URL: "http://localhost:3000",
  JWT_SECRET: "rating-integration-secret-".repeat(3),
};
const cookie = (user) =>
  `pms_session=${jwt.sign({ version: 0 }, config.JWT_SECRET, { subject: String(user._id), expiresIn: "1h", issuer: "pms", audience: "pms-web" })}`;
function call(method, path, body, auth = adminCookie) {
  const r = request(app)
    [method](`/api${path}`)
    .set("Cookie", auth)
    .set("X-PMS-Request", "1");
  return body === undefined ? r : r.send(body);
}
before(async () => {
  repl = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    binary: { version: "7.0.14", downloadDir: ".cache/mongodb-binaries" },
  });
  await connectDatabase(repl.getUri());
  app = createApp(config);
  admin = await makePlayer(1, "admin");
  adminCookie = cookie(admin);
});
after(async () => {
  await mongoose.disconnect();
  await repl?.stop();
});
async function makePlayer(rank = 1, role = "player") {
  const n = ++index;
  return User.create({
    fullName: `Rating player ${n}`,
    username: `rating${n}`,
    email: `rating${n}@example.test`,
    passwordHash: "not-used-for-test-session-signin",
    role,
    provisionalRanking: rank,
  });
}
async function settings(values = {}) {
  const res = await call("put", "/admin/ratings/settings", {
    ...DEFAULT_RATING_POLICY,
    enabled: true,
    ...values,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.rating;
}
async function fixture({
  players,
  rank = 1,
  rated = true,
  type = "open-play",
} = {}) {
  players ||= await Promise.all(
    Array.from({ length: 4 }, () => makePlayer(rank)),
  );
  const event = await Event.create({
    eventName: `Rated event ${index}`,
    eventType: type,
    location: "Club courts",
    startDateTime: new Date(Date.now() - 86400_000),
    endDateTime: new Date(Date.now() + 86400_000),
    registrationOpen: new Date(Date.now() - 3 * 86400_000),
    registrationDeadline: new Date(Date.now() - 2 * 86400_000),
    capacity: 24,
    createdBy: admin._id,
    status: "ongoing",
    format: "round-robin",
    rated,
  });
  const teams = await Team.create(
    [0, 1].map((i) => ({
      eventId: event._id,
      generationBatchId: "rating-test",
      players: players.slice(i * 2, i * 2 + 2).map((p) => p._id),
      assignmentStatus: "finalized",
    })),
  );
  return { players, event, teams };
}
async function newMatch(f, offset = -1000, rated = f.event.rated) {
  return Match.create({
    eventId: f.event._id,
    teamA: f.teams[0]._id,
    teamB: f.teams[1]._id,
    courtNumber: "1",
    roundNumber: 1,
    rated,
    ...(offset !== null ? { completedAt: new Date(Date.now() + offset) } : {}),
  });
}
const finalize = (m, wonA = true, extra = {}) =>
  call("post", `/matches/${m._id}/results`, {
    scores: [wonA ? { a: 11, b: 5 } : { a: 5, b: 11 }],
    revision: m.revision,
    ...extra,
  });
const profile = (p) =>
  PlayerRating.findOne({ playerId: p._id, pool: "doubles" }).lean();

test("rated finalization records four zero-sum adjustments and duplicate submissions stay idempotent", async () => {
  await settings();
  const f = await fixture(),
    m = await newMatch(f);
  const responses = await Promise.all([finalize(m), finalize(m)]);
  assert.ok(
    responses.every((r) => r.status === 200),
    JSON.stringify(responses.map((r) => r.body)),
  );
  const ledger = await RatingHistory.find({ matchId: m._id });
  assert.equal(ledger.length, 4);
  assert.equal(
    ledger.reduce((n, h) => n + h.adjustment, 0),
    0,
  );
  for (let i = 0; i < 4; i++) {
    const p = await profile(f.players[i]);
    assert.equal(p.rating, i < 2 ? 116 : 84);
    assert.equal(p.ratedMatches, 1);
    assert.equal(p.automaticConfirmed, false);
  }
  const snapshot = ledger
    .map((h) => ({ id: String(h._id), rating: h.newRating }))
    .sort((a, b) => a.id.localeCompare(b.id));
  await finalize(m);
  assert.deepEqual(
    (await RatingHistory.find({ matchId: m._id }))
      .map((h) => ({ id: String(h._id), rating: h.newRating }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    snapshot,
  );
});
test("disabled and unrated matches do not adjust ratings; explicit retrospective opt-in works", async () => {
  await settings({ enabled: false });
  const f = await fixture(),
    m = await newMatch(f);
  assert.equal((await finalize(m)).status, 200);
  assert.equal(await RatingHistory.countDocuments({ matchId: m._id }), 0);
  assert.equal((await profile(f.players[0])).rating, 100);
  await settings();
  const unchanged = await call("post", "/admin/ratings/recalculate", {
    reason: "Confirm opt-in policy",
  });
  assert.equal(unchanged.status, 200);
  assert.equal(await RatingHistory.countDocuments({ matchId: m._id }), 0);
  const optIn = await call("put", `/matches/${m._id}/rating`, {
    rated: true,
    revision: 1,
    reason: "Approved for club Elo",
  });
  assert.equal(optIn.status, 200, JSON.stringify(optIn.body));
  assert.equal(await RatingHistory.countDocuments({ matchId: m._id }), 4);
  const unrated = await newMatch(f, null, false);
  await finalize(unrated);
  assert.equal(await RatingHistory.countDocuments({ matchId: unrated._id }), 0);
  const optOut = await call("put", `/matches/${m._id}/rating`, {
    rated: false,
    revision: 2,
    reason: "Practice score only",
  });
  assert.equal(optOut.status, 200);
  assert.equal((await profile(f.players[0])).rating, 100);
});
test("tenth rated result confirms the category; promotion respects hysteresis and replay does not resend notifications", async () => {
  await settings();
  const f = await fixture();
  for (let i = 0; i < 12; i++) {
    const m = await newMatch(f, -10000 + i);
    assert.equal((await finalize(m)).status, 200);
    if (i === 8) {
      const p = await User.findById(f.players[0]._id);
      assert.equal(p.officialRanking, undefined);
      assert.equal(p.automaticRankingStatus, "provisional");
    }
  }
  const p = await User.findById(f.players[0]._id);
  assert.equal(p.officialRanking, 2);
  assert.equal(p.doublesRatedMatches, 12);
  assert.equal(p.automaticRankingStatus, "confirmed");
  const filter = { userId: p._id, title: "Player promoted" };
  assert.equal(await Notification.countDocuments(filter), 1);
  await call("post", "/admin/ratings/recalculate", {
    reason: "Verify deterministic replay",
  });
  assert.equal(await Notification.countDocuments(filter), 1);
});
test("demotions are confirmed only after the minimum rated-match count", async () => {
  await settings();
  const f = await fixture({ rank: 2 });
  for (let i = 0; i < 12; i++)
    assert.equal(
      (await finalize(await newMatch(f, -10000 + i), false)).status,
      200,
    );
  const p = await User.findById(f.players[0]._id);
  assert.equal(p.officialRanking, 1);
  assert.equal(
    await Notification.countDocuments({
      userId: p._id,
      title: "Player demoted",
    }),
    1,
  );
});
test("correction and invalidation replay later opponents in chronological order across both event types", async () => {
  await settings();
  const first = await fixture(),
    m1 = await newMatch(first, -20000);
  await finalize(m1);
  const extra = [await makePlayer(), await makePlayer()];
  const later = await fixture({
    players: [first.players[0], extra[0], first.players[2], extra[1]],
    type: "tournament",
  });
  const m2 = await newMatch(later, -10000);
  assert.equal((await finalize(m2)).status, 200);
  const previous = (await profile(extra[0])).rating;
  const corrected = await call("put", `/matches/${m1._id}/results`, {
    scores: [{ a: 5, b: 11 }],
    revision: 1,
  });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.body));
  assert.notEqual((await profile(extra[0])).rating, previous);
  const ids = [...first.players, ...extra].map((p) => String(p._id));
  const matchDocs = await Match.find({ _id: { $in: [m1._id, m2._id] } })
    .populate("teamA teamB")
    .lean();
  const expected = replayRatings(
    ids.map((playerId) => ({
      playerId,
      baselineRating: 100,
      baselineRank: 1,
      baselineRankingStatus: "provisional",
    })),
    matchDocs.map((m) => ({
      id: m._id,
      kind: "match",
      teamA: m.teamA.players,
      teamB: m.teamB.players,
      wonA: String(m.winner) === String(m.teamA._id),
      policy: m.ratingPolicy,
      timestamp: m.completedAt,
    })),
  );
  for (const state of expected.states)
    assert.equal(
      (await PlayerRating.findOne({ playerId: state.playerId })).rating,
      state.rating,
    );
  const invalidated = await call("delete", `/matches/${m1._id}/results`, {
    revision: 2,
    reason: "Score recorded against wrong team",
    cascadeCorrection: true,
  });
  assert.equal(invalidated.status, 200, JSON.stringify(invalidated.body));
  assert.equal(await RatingHistory.countDocuments({ matchId: m1._id }), 0);
  assert.equal((await profile(extra[0])).rating, 116);
  assert.equal((await profile(first.players[1])).ratedMatches, 0);
});
test("K-factor snapshots survive configuration changes and concurrent finals serialize across events", async () => {
  await settings();
  const f = await fixture();
  const m1 = await newMatch(f, -20000);
  await finalize(m1);
  await settings({ kFactor: 64 });
  const otherEvent = await fixture({ players: f.players });
  const m2 = await newMatch(f, -10000),
    m3 = await newMatch(otherEvent, -5000);
  const responses = await Promise.all([finalize(m2), finalize(m3, false)]);
  assert.ok(responses.every((r) => r.status === 200));
  assert.equal((await Match.findById(m1._id)).ratingPolicy.kFactor, 32);
  assert.equal((await Match.findById(m2._id)).ratingPolicy.kFactor, 64);
  assert.equal(
    await RatingHistory.countDocuments({
      playerId: f.players[0]._id,
      kind: "match",
    }),
    3,
  );
  const before = (await profile(f.players[0])).rating;
  await call("post", "/admin/ratings/recalculate", {
    reason: "Replay policy snapshots",
  });
  assert.equal((await profile(f.players[0])).rating, before);
});

test("tournament cascade correction removes descendant rating effects and the old champion", async () => {
  await settings();
  const f = await fixture({ type: "tournament" });
  const extra = await Promise.all(
    Array.from({ length: 4 }, () => makePlayer()),
  );
  await Team.create(
    [0, 1].map((i) => ({
      eventId: f.event._id,
      generationBatchId: "rating-test",
      players: extra.slice(i * 2, i * 2 + 2).map((p) => p._id),
      assignmentStatus: "finalized",
    })),
  );
  f.event.finalizedBatch = "rating-test";
  f.event.format = "single-elimination";
  await f.event.save();
  assert.equal(
    (await call("post", `/events/${f.event._id}/generate-matches`, {})).status,
    200,
  );
  const firstRound = await Match.find({ eventId: f.event._id, roundNumber: 1 });
  for (const m of firstRound) assert.equal((await finalize(m)).status, 200);
  const final = await Match.findOne({ eventId: f.event._id, roundNumber: 2 });
  assert.equal((await finalize(final)).status, 200);
  assert.equal(await RatingHistory.countDocuments({ matchId: final._id }), 4);
  const correction = await call(
    "put",
    `/matches/${firstRound[0]._id}/results`,
    { scores: [{ a: 5, b: 11 }], revision: 1, cascadeCorrection: true },
  );
  assert.equal(correction.status, 200, JSON.stringify(correction.body));
  assert.equal(await RatingHistory.countDocuments({ matchId: final._id }), 0);
  assert.equal((await Match.findById(final._id)).matchStatus, "scheduled");
});
test("manual overrides are documented, persist across corrections, and can be released", async () => {
  await settings();
  const f = await fixture(),
    m = await newMatch(f, -20000);
  await finalize(m);
  const id = String(f.players[0]._id);
  assert.equal(
    (
      await call("put", `/admin/players/${id}/rating-override`, {
        action: "manual",
        ranking: 5,
        rating: 910,
        reason: "Observed club assessment",
      })
    ).status,
    200,
  );
  const profileAfterOverride = await profile(f.players[0]);
  assert.equal(profileAfterOverride.rating, 910);
  assert.equal(profileAfterOverride.manualLocked, true);
  await call("put", `/matches/${m._id}/results`, {
    scores: [{ a: 5, b: 11 }],
    revision: 1,
  });
  assert.equal((await profile(f.players[0])).rating, 910);
  assert.equal((await User.findById(id)).officialRanking, 5);
  assert.equal(await RatingOverride.countDocuments({ playerId: id }), 1);
  assert.equal(
    (
      await call("put", `/admin/players/${id}/rating-override`, {
        action: "release",
        reason: "Return to performance ranking",
      })
    ).status,
    200,
  );
  assert.equal((await profile(f.players[0])).manualLocked, false);
  assert.ok(await AuditLog.exists({ entityId: id, action: "override-rating" }));
});
test("rating APIs enforce roles, ownership, supported pools, validation and history pagination", async () => {
  await settings();
  const f = await fixture(),
    m = await newMatch(f);
  await finalize(m);
  const auth = cookie(f.players[0]);
  assert.equal(
    (
      await call(
        "put",
        "/admin/ratings/settings",
        { ...DEFAULT_RATING_POLICY, enabled: true },
        auth,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "put",
        `/matches/${m._id}/rating`,
        { rated: false, revision: 1, reason: "Unauthorized change" },
        auth,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call("put", "/admin/ratings/settings", {
        ...DEFAULT_RATING_POLICY,
        minimumRatedMatches: 9,
      })
    ).status,
    400,
  );
  assert.equal(
    (await call("get", "/players/me/rating?pool=singles", undefined, auth))
      .status,
    400,
  );
  assert.equal(
    (await call("get", "/players/me/rating?limit=999", undefined, auth)).status,
    400,
  );
  const response = await call(
    "get",
    "/players/me/rating-history?limit=1",
    undefined,
    auth,
  );
  assert.equal(response.status, 200);
  assert.equal(response.body.history.length, 1);
  assert.equal(response.body.profile.rating, 116);
  assert.ok(
    response.body.history.every((h) => h.playerId === String(f.players[0]._id)),
  );
  assert.equal(
    (
      await call(
        "put",
        `/players/me`,
        {
          fullName: "Protected profile",
          doublesRating: 9999,
          officialRanking: 12,
        },
        auth,
      )
    ).status,
    200,
  );
  assert.equal((await User.findById(f.players[0]._id)).doublesRating, 116);
  assert.equal(
    (
      await call("put", "/admin/settings", {
        leaderboardOrder: "rating",
        minimumMatches: 0,
      })
    ).status,
    200,
  );
  const board = await call("get", "/leaderboard", undefined, auth);
  assert.equal(board.status, 200);
  assert.ok(
    board.body.players.every(
      (p, i, a) => i === 0 || a[i - 1].rating >= p.rating,
    ),
  );
});
test("migration backfills legacy records without rating historical matches and is idempotent", async () => {
  const legacy = await fixture({ rank: 7, rated: false });
  const m = await newMatch(legacy);
  await finalize(m);
  await Event.collection.updateOne(
    { _id: legacy.event._id },
    { $unset: { rated: 1 } },
  );
  await Match.collection.updateOne({ _id: m._id }, { $unset: { rated: 1 } });
  await Team.collection.updateMany(
    { eventId: legacy.event._id },
    { $unset: { combinedRating: 1 } },
  );
  const first = await migrateRatings();
  assert.equal(first.alreadyApplied, undefined);
  const second = await migrateRatings();
  assert.equal(second.alreadyApplied, true);
  assert.equal((await Match.findById(m._id)).rated, false);
  assert.equal(await RatingHistory.countDocuments({ matchId: m._id }), 0);
  const team = await Team.findById(legacy.teams[0]._id);
  assert.equal(team.combinedRating, 2600);
  assert.equal((await profile(legacy.players[0])).rating, seedRating(7));
});
test("rating dashboard and settings controls use real APIs and feed Chart.js data", async () => {
  await settings();
  const f = await fixture(),
    m = await newMatch(f);
  await finalize(m);
  const dom = new JSDOM(
    '<main id="content"><div class="stats-grid"></div></main>',
    { url: "http://localhost:3000/" },
  );
  const names = ["document", "window", "fetch", "FormData", "Swal"];
  const original = Object.fromEntries(names.map((n) => [n, globalThis[n]]));
  Object.assign(globalThis, {
    document: dom.window.document,
    window: dom.window,
    FormData: dom.window.FormData,
    Swal: { fire: async () => ({ isConfirmed: false }) },
  });
  let auth = cookie(f.players[0]);
  globalThis.fetch = async (url, options = {}) => {
    const r = await call(
      (options.method || "GET").toLowerCase(),
      url.replace(/^\/api/, ""),
      options.body ? JSON.parse(options.body) : undefined,
      auth,
    );
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  try {
    const { mountPlayerRating, mountRatingSettings } =
      await import("../public/js/ratings.js");
    const rankings = Array.from({ length: 12 }, (_, i) => `Category ${i + 1}`);
    const charts = [];
    await mountPlayerRating(
      document.querySelector("#content"),
      rankings,
      (...args) => charts.push(args),
    );
    assert.match(document.querySelector("#content").textContent, /116\.0/);
    assert.equal(charts[0][0], "rating-progression");
    assert.deepEqual(charts[0][3][0].data, [116]);
    auth = adminCookie;
    await mountRatingSettings(document.querySelector("#content"), rankings);
    const form = document.querySelector("#rating-settings-form");
    form.elements.kFactor.value = "48";
    await form.onsubmit({
      preventDefault() {},
      target: form,
      submitter: { disabled: false },
    });
    assert.equal(
      (await Settings.findOne({ key: "global" })).rating.kFactor,
      48,
    );
    assert.equal(document.querySelectorAll(".promotion-threshold").length, 11);
  } finally {
    Object.assign(globalThis, original);
    dom.window.close();
  }
});

test("main player dashboard mounts the rating panel and Chart.js progression", async () => {
  await settings();
  const f = await fixture(),
    m = await newMatch(f);
  await finalize(m);
  const dom = new JSDOM('<div id="app"></div><div id="announcer"></div>', {
    url: "http://localhost:3000/#/dashboard",
  });
  const keys = [
    "document",
    "window",
    "location",
    "history",
    "sessionStorage",
    "FormData",
    "fetch",
    "Chart",
    "Swal",
    "lucide",
  ];
  const original = Object.fromEntries(
    keys.map((key) => [key, globalThis[key]]),
  );
  const charts = [];
  class TestChart {
    constructor(canvas, config) {
      this.canvas = canvas;
      charts.push({ id: canvas.id, config });
    }
    destroy() {
      this.canvas = null;
    }
  }
  Object.assign(globalThis, {
    document: dom.window.document,
    window: dom.window,
    location: dom.window.location,
    history: dom.window.history,
    sessionStorage: dom.window.sessionStorage,
    FormData: dom.window.FormData,
    Chart: TestChart,
    Swal: {
      fire: async () => ({ isConfirmed: false }),
      isVisible: () => false,
    },
    lucide: { createIcons() {} },
  });
  globalThis.fetch = async (url, options = {}) => {
    const response = await call(
      (options.method || "GET").toLowerCase(),
      url.replace(/^\/api/, ""),
      options.body ? JSON.parse(options.body) : undefined,
      cookie(f.players[0]),
    );
    return {
      ok: response.status < 400,
      status: response.status,
      json: async () => response.body,
    };
  };
  try {
    await import("../public/js/app.js?ratings-dashboard-test");
    assert.ok(document.querySelector("#rating-progression"));
    assert.match(
      document.querySelector("#content").textContent,
      /Your doubles rating/,
    );
    const progression = charts.find((c) => c.id === "rating-progression");
    assert.equal(progression.config.type, "line");
    assert.deepEqual(progression.config.data.datasets[0].data, [116]);
  } finally {
    Object.assign(globalThis, original);
    dom.window.close();
  }
});
