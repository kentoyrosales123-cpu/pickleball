import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import request from "supertest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { createApp } from "../src/app.js";
import {
  connectDatabase,
  User,
  Event,
  EventRegistration,
  Team,
  Match,
  Tournament,
  ActionToken,
} from "../src/models/index.js";
import { digest } from "../src/services/mail.js";
import { JSDOM } from "jsdom";
let repl, app, admin, players, adminCookie, playerCookie;
const config = {
  NODE_ENV: "test",
  APP_URL: "http://localhost:3000",
  JWT_SECRET: "test-only-secret-".repeat(5),
};
const cookie = (u) =>
  `pms_session=${jwt.sign({ version: 0 }, config.JWT_SECRET, { subject: String(u._id), expiresIn: "1h", issuer: "pms", audience: "pms-web" })}`;
const call = (method, url, body, auth = adminCookie) => {
  const r = request(app)
    [method](`/api${url}`)
    .set("Cookie", auth || "")
    .set("X-PMS-Request", "1");
  return body === undefined ? r : r.send(body);
};
before(async () => {
  repl = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    binary: { version: "7.0.14", downloadDir: ".cache/mongodb-binaries" },
  });
  await connectDatabase(repl.getUri());
  app = createApp(config);
  const hash = await bcrypt.hash("Testing-player-password-938", 4);
  admin = await User.create({
    fullName: "Administrator",
    username: "admin",
    email: "admin@example.test",
    passwordHash: hash,
    role: "super-admin",
    provisionalRanking: 1,
  });
  players = await User.insertMany(
    Array.from({ length: 24 }, (_, i) => ({
      fullName: `Player ${i + 1}`,
      username: `player${i + 1}`,
      email: `player${i + 1}@example.test`,
      passwordHash: hash,
      provisionalRanking: (i % 12) + 1,
    })),
  );
  adminCookie = cookie(admin);
  playerCookie = cookie(players[0]);
});
after(async () => {
  await mongoose.disconnect();
  await repl?.stop();
});
async function createEvent(overrides = {}) {
  const start = new Date(Date.now() + 4 * 86400_000);
  const data = {
    eventName: "Integration Rally",
    eventType: "open-play",
    location: "Court Center",
    startDateTime: start.toISOString(),
    endDateTime: new Date(+start + 7 * 86400_000).toISOString(),
    registrationOpen: new Date(Date.now() - 86400_000).toISOString(),
    registrationDeadline: new Date(+start - 86400_000).toISOString(),
    capacity: 24,
    minRanking: 1,
    maxRanking: 12,
    courts: ["1", "2", "3"],
    format: "round-robin",
    targetPoints: 11,
    winningMargin: 2,
    bestOf: 1,
    rounds: 3,
    matchDuration: 20,
    status: "registration-open",
    waitlistEnabled: true,
    ...overrides,
  };
  const res = await call("post", "/events", data);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.event;
}
async function prepare(event, count = 8) {
  for (const p of players.slice(0, count))
    assert.equal(
      (
        await call("post", `/events/${event._id}/participants`, {
          userId: String(p._id),
        })
      ).status,
      200,
    );
  assert.equal(
    (
      await call("post", `/events/${event._id}/generate-teams`, {
        mode: "balanced",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call("post", `/events/${event._id}/finalize-teams`, {
        allowSubstitutes: false,
      })
    ).status,
    200,
  );
  assert.equal(
    (await call("post", `/events/${event._id}/generate-matches`, {})).status,
    200,
  );
}
test("authentication, ownership, CSRF, role checks and single-use reset tokens", async () => {
  assert.equal((await call("get", "/auth/me", undefined, "")).status, 401);
  assert.equal(
    (await call("get", "/admin/players", undefined, playerCookie)).status,
    403,
  );
  assert.equal(
    (await request(app).post("/api/auth/login").send({})).status,
    403,
  );
  const login = await call(
    "post",
    "/auth/login",
    { email: players[0].email, password: "Testing-player-password-938" },
    "",
  );
  assert.equal(login.status, 200);
  assert.ok(login.headers["set-cookie"][0].includes("HttpOnly"));
  assert.equal(login.body.user.passwordHash, undefined);
  const registered = await call(
    "post",
    "/auth/register",
    {
      fullName: "New Member",
      username: "newmember",
      email: "new@example.test",
      phone: "09123456789",
      password: "Strong-new-password-1",
      confirmPassword: "Strong-new-password-1",
      provisionalRanking: 3,
      role: "super-admin",
    },
    "",
  );
  assert.equal(registered.status, 201);
  assert.equal(registered.body.user.role, "player");
  assert.equal(
    (
      await call(
        "put",
        "/players/me",
        {
          fullName: "Updated Player",
          officialRanking: 12,
          role: "super-admin",
        },
        playerCookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (await User.findById(players[0]._id)).officialRanking,
    undefined,
  );
  const raw = "a".repeat(64);
  await ActionToken.create({
    userId: players[23]._id,
    hash: digest(raw),
    purpose: "reset",
    expiresAt: new Date(Date.now() + 60000),
  });
  const reset = {
    purpose: "reset",
    token: raw,
    password: "Reset-new-password-123",
  };
  assert.equal((await call("post", "/auth/action", reset, "")).status, 200);
  assert.equal((await call("post", "/auth/action", reset, "")).status, 400);
  assert.equal(
    (await call("get", "/auth/me", undefined, cookie(players[23]))).status,
    401,
  );
});
test("concurrent registration never exceeds capacity; duplicates and waitlist promotion are consistent", async () => {
  const event = await createEvent({ capacity: 4 });
  const results = await Promise.all(
    players
      .slice(0, 12)
      .map((p) => call("post", `/events/${event._id}/register`, {}, cookie(p))),
  );
  assert.ok(
    results.every((r) => r.status === 200),
    JSON.stringify(results.map((r) => r.body)),
  );
  assert.equal(
    await EventRegistration.countDocuments({
      eventId: event._id,
      registrationStatus: "confirmed",
    }),
    4,
  );
  assert.equal((await Event.findById(event._id)).confirmedCount, 4);
  const confirmed = await EventRegistration.findOne({
    eventId: event._id,
    registrationStatus: "confirmed",
  });
  assert.equal(
    (
      await call(
        "post",
        `/events/${event._id}/register`,
        {},
        cookie(players.find((p) => String(p._id) === String(confirmed.userId))),
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await call(
        "delete",
        `/events/${event._id}/participants/${confirmed.userId}`,
      )
    ).status,
    200,
  );
  assert.equal(
    await EventRegistration.countDocuments({
      eventId: event._id,
      registrationStatus: "confirmed",
    }),
    4,
  );
});
test("eligibility, deadline, full event, draft teams and roster locking", async () => {
  const restricted = await createEvent({
    minRanking: 10,
    capacity: 4,
    waitlistEnabled: false,
  });
  assert.equal(
    (await call("post", `/events/${restricted._id}/register`, {}, playerCookie))
      .status,
    400,
  );
  const full = await createEvent({ capacity: 4, waitlistEnabled: false });
  const result = await Promise.all(
    players
      .slice(0, 6)
      .map((p) => call("post", `/events/${full._id}/register`, {}, cookie(p))),
  );
  assert.equal(result.filter((r) => r.status === 200).length, 4);
  assert.equal(result.filter((r) => r.status === 409).length, 2);
  const draft = await call("post", `/events/${full._id}/generate-teams`, {
    mode: "balanced",
  });
  assert.equal(draft.status, 200);
  assert.equal(
    (await call("get", `/events/${full._id}/teams`, undefined, playerCookie))
      .body.teams.length,
    0,
  );
  assert.equal(
    (await call("post", `/events/${full._id}/finalize-teams`, {})).status,
    200,
  );
  assert.equal(
    (
      await call(
        "delete",
        `/events/${full._id}/register`,
        undefined,
        playerCookie,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call("post", `/events/${full._id}/generate-teams`, {
        mode: "random",
      })
    ).status,
    400,
  );
});
test("result submissions are idempotent and corrections replace statistics for both partners", async () => {
  const event = await createEvent();
  await prepare(event, 4);
  const match = await Match.findOne({ eventId: event._id });
  const payload = { scores: [{ a: 11, b: 5 }], revision: 0 };
  assert.equal(
    (await call("post", `/matches/${match._id}/results`, payload, playerCookie))
      .status,
    403,
  );
  const submissions = await Promise.all([
    call("post", `/matches/${match._id}/results`, payload),
    call("post", `/matches/${match._id}/results`, payload),
  ]);
  assert.ok(submissions.every((r) => r.status === 200));
  const a = await Team.findById(match.teamA);
  for (const id of a.players) {
    const stats = (
      await call(
        "get",
        "/players/me/stats",
        undefined,
        cookie(players.find((p) => String(p._id) === String(id))),
      )
    ).body;
    assert.equal(stats.wins, 1);
    assert.equal(stats.matches, 1);
  }
  assert.equal(
    (
      await call("put", `/matches/${match._id}/results`, {
        scores: [{ a: 5, b: 11 }],
        revision: 0,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call("put", `/matches/${match._id}/results`, {
        scores: [{ a: 5, b: 11 }],
        revision: 1,
      })
    ).status,
    200,
  );
  for (const id of a.players) {
    const stats = (
      await call(
        "get",
        "/players/me/stats",
        undefined,
        cookie(players.find((p) => String(p._id) === String(id))),
      )
    ).body;
    assert.equal(stats.wins, 0);
    assert.equal(stats.losses, 1);
  }
});
for (const format of [
  "single-elimination",
  "double-elimination",
  "round-robin",
  "group-knockout",
])
  test(`${format} advances to a champion with non-power-of-two teams`, async () => {
    const event = await createEvent({ eventType: "tournament", format });
    await prepare(event, 10);
    let played = 0;
    for (let loop = 0; loop < 60; loop++) {
      const match = await Match.findOne({
        eventId: event._id,
        matchStatus: "scheduled",
      }).sort({ roundNumber: 1 });
      if (!match) break;
      // Lower bracket champion wins the first final, exercising reset behavior.
      const res = await call("post", `/matches/${match._id}/results`, {
        scores: [match.bracketKey === "GF" ? { a: 5, b: 11 } : { a: 11, b: 5 }],
        revision: match.revision,
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      played++;
    }
    const tournament = await Tournament.findOne({ eventId: event._id });
    assert.ok(
      tournament.champion,
      `${format} lacks champion after ${played} matches`,
    );
    assert.equal(
      await Match.countDocuments({
        eventId: event._id,
        matchStatus: { $in: ["pending", "scheduled"] },
      }),
      0,
    );
    if (format === "double-elimination")
      assert.equal(
        await Match.countDocuments({
          eventId: event._id,
          bracketKey: "RESET",
          matchStatus: "finalized",
        }),
        1,
      );
  });
test("notifications are private, profile fields are bounded, and admin actions are audited", async () => {
  const own = await call("get", "/notifications", undefined, playerCookie);
  assert.ok(
    own.body.notifications.every((n) => n.userId === String(players[0]._id)),
  );
  assert.equal(
    (
      await call("put", `/admin/players/${players[0]._id}/ranking`, {
        ranking: 8,
        reason: "Observed assessment",
      })
    ).status,
    200,
  );
  assert.equal((await User.findById(players[0]._id)).officialRanking, 8);
  assert.ok(
    (await call("get", "/admin/audit-logs")).body.logs.some(
      (l) => l.action === "confirm-ranking",
    ),
  );
});

test("reopening assignments requires confirmation and is blocked after official results", async () => {
  const event = await createEvent();
  await prepare(event, 4);
  assert.equal(
    (await call("post", `/events/${event._id}/reopen-teams`, {})).status,
    400,
  );
  assert.equal(
    (await call("post", `/events/${event._id}/reopen-teams`, { confirm: true }))
      .status,
    200,
  );
  assert.equal(await Match.countDocuments({ eventId: event._id }), 0);
  assert.equal((await Event.findById(event._id)).finalizedBatch, undefined);
  await call("post", `/events/${event._id}/finalize-teams`, {});
  await call("post", `/events/${event._id}/generate-matches`, {});
  const match = await Match.findOne({ eventId: event._id });
  await call("post", `/matches/${match._id}/results`, {
    scores: [{ a: 11, b: 0 }],
    revision: 0,
  });
  assert.equal(
    (await call("post", `/events/${event._id}/reopen-teams`, { confirm: true }))
      .status,
    400,
  );
});
test("cascade result correction clears downstream scores and champion atomically", async () => {
  const event = await createEvent({
    eventType: "tournament",
    format: "single-elimination",
  });
  await prepare(event, 8);
  const first = await Match.find({ eventId: event._id, roundNumber: 1 });
  for (const m of first)
    await call("post", `/matches/${m._id}/results`, {
      scores: [{ a: 11, b: 4 }],
      revision: 0,
    });
  const final = await Match.findOne({ eventId: event._id, roundNumber: 2 });
  assert.equal(
    (
      await call("post", `/matches/${final._id}/results`, {
        scores: [{ a: 11, b: 4 }],
        revision: 0,
      })
    ).status,
    200,
  );
  const correction = { scores: [{ a: 4, b: 11 }], revision: 1 };
  assert.equal(
    (await call("put", `/matches/${first[0]._id}/results`, correction)).status,
    400,
  );
  assert.equal(
    (
      await call("put", `/matches/${first[0]._id}/results`, {
        ...correction,
        cascadeCorrection: true,
      })
    ).status,
    200,
  );
  const updated = await Match.findById(final._id);
  assert.equal(updated.matchStatus, "scheduled");
  assert.equal(updated.scores.length, 0);
  assert.equal(updated.completedAt, undefined);
  assert.equal(
    (await Tournament.findOne({ eventId: event._id })).champion,
    undefined,
  );
  assert.equal(
    await Match.countDocuments({
      eventId: event._id,
      matchStatus: "finalized",
    }),
    2,
  );
});
test("player-selected partner proposals require administrator review and prevent duplicate assignments", async () => {
  const event = await createEvent({
    teamMode: "player-selected",
    eventType: "tournament",
    format: "single-elimination",
  });
  for (const p of players.slice(0, 4))
    await call("post", `/events/${event._id}/participants`, {
      userId: String(p._id),
    });
  const body = { partnerId: String(players[1]._id) };
  assert.equal(
    (
      await call(
        "post",
        `/events/${event._id}/partner-requests`,
        body,
        playerCookie,
      )
    ).status,
    200,
  );
  const proposal = (await call("get", `/events/${event._id}/partner-requests`))
    .body.proposals[0];
  assert.equal(
    (
      await call(
        "put",
        `/events/${event._id}/partner-requests/${proposal._id}`,
        { approve: true },
        playerCookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "put",
        `/events/${event._id}/partner-requests/${proposal._id}`,
        { approve: true },
      )
    ).status,
    200,
  );
  const teams = await Team.find({ eventId: event._id });
  assert.equal(teams.length, 1);
  assert.equal(teams[0].players.length, 2);
});
test("event interface drives real registration, draft, publication and schedule APIs", async () => {
  const event = await createEvent();
  for (const p of players.slice(0, 8))
    await call("post", `/events/${event._id}/participants`, {
      userId: String(p._id),
    });
  const dom = new JSDOM('<main id="content"></main>', {
    url: "http://localhost:3000/",
  });
  const original = {
    document: globalThis.document,
    window: globalThis.window,
    fetch: globalThis.fetch,
    Swal: globalThis.Swal,
    lucide: globalThis.lucide,
  };
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.lucide = { createIcons() {} };
  globalThis.Swal = { fire: async () => ({ isConfirmed: true }) };
  globalThis.fetch = async (url, options = {}) => {
    const res = await call(
      (options.method || "GET").toLowerCase(),
      url.replace(/^\/api/, ""),
      options.body ? JSON.parse(options.body) : undefined,
    );
    return {
      ok: res.status < 400,
      status: res.status,
      json: async () => res.body,
    };
  };
  const waitFor = async (selector) => {
    for (let i = 0; i < 100; i++) {
      const element = document.querySelector(selector);
      if (element) return element;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`UI did not render ${selector}`);
  };
  try {
    const { eventDetail } = await import("../public/js/events.js");
    const state = {
      user: {
        id: String(admin._id),
        role: "super-admin",
        provisionalRanking: 1,
      },
      rankings: Array.from({ length: 12 }, (_, i) => `Level ${i + 1}`),
      render: async () => {},
    };
    await eventDetail(document.querySelector("#content"), state, event._id);
    assert.ok(document.querySelector('[data-tab="teams"]'));
    await document.querySelector('[data-tab="teams"]').onclick();
    await document.querySelector("#generate-teams").onclick();
    const finalize = await waitFor("#finalize-teams");
    assert.equal(document.querySelectorAll(".team-player").length, 8);
    await finalize.onclick();
    await waitFor("#reopen-teams");
    await document.querySelector('[data-tab="matches"]').onclick();
    await document.querySelector("#generate-matches").onclick();
    await waitFor(".match-card");
    assert.equal(document.querySelectorAll(".match-card").length, 6);
    assert.equal(await Match.countDocuments({ eventId: event._id }), 6);
    assert.ok(!document.querySelector("#generate-matches"));
  } finally {
    Object.assign(globalThis, original);
    dom.window.close();
  }
});

test("rotating partners fairly rotate an odd roster without player or court overlap", async () => {
  const event = await createEvent({ format: "rotating", rounds: 9 });
  for (const p of players.slice(0, 9))
    await call("post", `/events/${event._id}/participants`, {
      userId: String(p._id),
    });
  await call("post", `/events/${event._id}/generate-teams`, {
    mode: "balanced",
  });
  assert.equal(
    (
      await call("post", `/events/${event._id}/finalize-teams`, {
        allowSubstitutes: true,
      })
    ).status,
    200,
  );
  assert.equal(
    (await call("post", `/events/${event._id}/generate-matches`, {})).status,
    200,
  );
  const matches = await Match.find({ eventId: event._id }).populate(
    "teamA teamB",
  );
  const counts = new Map(players.slice(0, 9).map((p) => [String(p._id), 0]));
  for (const round of new Set(matches.map((m) => m.roundNumber))) {
    const active = matches
      .filter((m) => m.roundNumber === round)
      .flatMap((m) => [...m.teamA.players, ...m.teamB.players].map(String));
    assert.equal(active.length, 8);
    assert.equal(new Set(active).size, 8);
    active.forEach((id) => counts.set(id, counts.get(id) + 1));
  }
  assert.equal(Math.max(...counts.values()) - Math.min(...counts.values()), 0);
});
test("random queue creates fresh teams each round and fairly rotates an odd roster", async () => {
  const event = await createEvent({ format: "random", rounds: 9 });
  for (const p of players.slice(0, 9))
    await call("post", `/events/${event._id}/participants`, {
      userId: String(p._id),
    });
  await call("post", `/events/${event._id}/generate-teams`, {
    mode: "balanced",
  });
  assert.equal(
    (
      await call("post", `/events/${event._id}/finalize-teams`, {
        allowSubstitutes: true,
      })
    ).status,
    200,
  );
  assert.equal(
    (await call("post", `/events/${event._id}/generate-matches`, {})).status,
    200,
  );
  const matches = await Match.find({ eventId: event._id }).populate(
    "teamA teamB",
  );
  assert.equal(matches.length, 18);
  assert.equal(
    new Set(matches.flatMap((m) => [String(m.teamA._id), String(m.teamB._id)]))
      .size,
    36,
  );
  for (const m of matches) {
    assert.equal(m.teamA.roundNumber, m.roundNumber);
    assert.equal(m.teamB.roundNumber, m.roundNumber);
  }
  const counts = new Map(players.slice(0, 9).map((p) => [String(p._id), 0]));
  for (const round of new Set(matches.map((m) => m.roundNumber))) {
    const active = matches
      .filter((m) => m.roundNumber === round)
      .flatMap((m) => [...m.teamA.players, ...m.teamB.players].map(String));
    assert.equal(active.length, 8);
    assert.equal(new Set(active).size, 8);
    active.forEach((id) => counts.set(id, counts.get(id) + 1));
  }
  assert.equal(Math.max(...counts.values()) - Math.min(...counts.values()), 0);
});
test("court changes enforce overlap, event window and administrator checks", async () => {
  const event = await createEvent();
  await prepare(event, 8);
  const matches = await Match.find({ eventId: event._id }).sort({
    startDateTime: 1,
  });
  const clash = {
    courtNumber: matches[1].courtNumber,
    startDateTime: matches[1].startDateTime.toISOString(),
  };
  assert.equal(
    (await call("put", `/matches/${matches[0]._id}/schedule`, clash)).status,
    409,
  );
  const valid = {
    courtNumber: "2",
    startDateTime: new Date(
      +new Date(event.endDateTime) - 20 * 60_000,
    ).toISOString(),
  };
  assert.equal(
    (
      await call(
        "put",
        `/matches/${matches[0]._id}/schedule`,
        valid,
        playerCookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (await call("put", `/matches/${matches[0]._id}/schedule`, valid)).status,
    200,
  );
  assert.equal(
    (
      await call("put", `/matches/${matches[0]._id}/schedule`, {
        ...valid,
        courtNumber: "nonexistent",
      })
    ).status,
    400,
  );
});
test("a reset-final result can be corrected without deleting its own match", async () => {
  const event = await createEvent({
    eventType: "tournament",
    format: "double-elimination",
  });
  await prepare(event, 4);
  for (let i = 0; i < 3; i++) {
    const match = await Match.findOne({
      eventId: event._id,
      matchStatus: "scheduled",
    }).sort({ roundNumber: 1 });
    const scores =
      match.bracketKey === "GF" ? [{ a: 4, b: 11 }] : [{ a: 11, b: 4 }];
    assert.equal(
      (
        await call("post", `/matches/${match._id}/results`, {
          scores,
          revision: match.revision,
        })
      ).status,
      200,
    );
  }
  const reset = await Match.findOne({
    eventId: event._id,
    bracketKey: "RESET",
  });
  assert.ok(reset);
  assert.equal(
    (
      await call("put", `/matches/${reset._id}/results`, {
        scores: [{ a: 4, b: 11 }],
        revision: 1,
        cascadeCorrection: true,
      })
    ).status,
    200,
  );
  assert.equal(
    String((await Tournament.findOne({ eventId: event._id })).champion),
    String(reset.teamB),
  );
});

test("super admins create player accounts without replacing their session", async () => {
  const data = {
    fullName: "Admin Created",
    username: "admin_created",
    email: "created@example.test",
    phone: "+15551234567",
    password: "Created-player-password-938",
    confirmPassword: "Created-player-password-938",
    provisionalRanking: 3,
    role: "player",
  };
  assert.equal((await call("post", "/admin/players", data, "")).status, 401);
  assert.equal(
    (await call("post", "/admin/players", data, playerCookie)).status,
    403,
  );
  assert.equal(
    (
      await call("post", "/admin/players", {
        ...data,
        confirmPassword: "mismatch",
      })
    ).status,
    400,
  );
  const result = await call("post", "/admin/players", data);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.headers["set-cookie"], undefined);
  assert.equal(result.body.user.role, "player");
  assert.equal(result.body.user.passwordHash, undefined);
  assert.equal((await call("get", "/auth/me")).body.user.id, String(admin._id));
  const stored = await User.findById(result.body.user.id).select(
    "+passwordHash",
  );
  assert.ok(await bcrypt.compare(data.password, stored.passwordHash));
  const { PlayerRanking } = await import("../src/models/ranking.js");
  assert.ok(await PlayerRanking.findOne({ userId: stored._id }));
  const { AuditLog } = await import("../src/models/index.js");
  const log = await AuditLog.findOne({
    entityId: String(stored._id),
    action: "create-user",
  });
  assert.ok(log);
  assert.equal(String(log.actorId), String(admin._id));
  assert.ok(!JSON.stringify(log).includes(data.password));
  assert.equal((await call("post", "/admin/players", data)).status, 409);
  assert.equal(
    (
      await call("post", "/admin/players", {
        ...data,
        email: "different@example.test",
      })
    ).status,
    409,
  );
  const login = await call(
    "post",
    "/auth/login",
    { email: data.email, password: data.password },
    "",
  );
  assert.equal(login.status, 200);
});

test("live queue reserves players, serializes courts, records results and returns players fairly", async () => {
  const event = await createEvent({ format: "random", courts: ["1", "2"] });
  const base = `/events/${event._id}/queue`;
  for (const p of players.slice(0, 9))
    await call("post", `/events/${event._id}/participants`, {
      userId: String(p._id),
    });
  assert.equal((await call("get", base, undefined, playerCookie)).status, 403);
  const prepared = await Promise.all([
    call("post", `${base}/prepare`, {}),
    call("post", `${base}/prepare`, {}),
  ]);
  assert.deepEqual(
    prepared.map((r) => r.status),
    [200, 200],
  );
  let data = (await call("get", base)).body;
  assert.equal(data.waiting.length, 1);
  const reserved = data.next.flatMap((m) =>
    [...m.teamA.players, ...m.teamB.players].map((p) => p._id),
  );
  assert.equal(new Set(reserved).size, 8);
  assert.equal(
    (await call("delete", `/events/${event._id}/participants/${reserved[0]}`))
      .status,
    409,
  );
  const starts = await Promise.all(
    data.next.map((m) =>
      call("post", `${base}/${m._id}/start`, { court: "1" }),
    ),
  );
  assert.deepEqual(starts.map((r) => r.status).sort(), [200, 409]);
  data = (await call("get", base)).body;
  const live = data.live[0],
    next = data.next[0];
  assert.equal(
    (await call("post", `${base}/${next._id}/start`, { court: "invalid" }))
      .status,
    400,
  );
  assert.equal(
    (
      await call("post", `/matches/${live._id}/results`, {
        scores: [{ a: 11, b: 5 }],
        revision: 0,
      })
    ).status,
    200,
  );
  data = (await call("get", base)).body;
  assert.equal(data.live.length, 0);
  assert.equal(data.waiting.length, 5);
  assert.equal(data.waiting[0].games, 0);
  assert.equal(data.waiting.filter((p) => p.lastResult === "W").length, 2);
  assert.equal((await call("delete", `${base}/${next._id}`)).status, 200);
  assert.equal((await call("get", base)).body.waiting.length, 9);
  assert.equal(
    (
      await call("post", `/matches/${live._id}/results`, {
        scores: [{ a: 11, b: 5 }],
        revision: 0,
      })
    ).status,
    200,
  );
  assert.equal((await call("get", base)).body.completed, 1);

  const dom = new JSDOM('<main id="queue"></main>', {
    url: "http://localhost:3000/",
  });
  const original = {
    document: globalThis.document,
    fetch: globalThis.fetch,
    Swal: globalThis.Swal,
  };
  globalThis.document = dom.window.document;
  globalThis.Swal = { fire: async () => ({ isConfirmed: true }) };
  globalThis.fetch = async (url, options = {}) => {
    const res = await call(
      (options.method || "GET").toLowerCase(),
      url.replace(/^\/api/, ""),
      options.body ? JSON.parse(options.body) : undefined,
    );
    return {
      ok: res.status < 400,
      status: res.status,
      json: async () => res.body,
    };
  };
  try {
    const { renderQueue } = await import("../public/js/queue.js");
    await renderQueue(document.querySelector("#queue"), event, () => {});
    assert.equal(
      document.querySelectorAll(".queue-courts .queue-card").length,
      2,
    );
    assert.equal(document.querySelectorAll(".queue-waiting li").length, 9);
    await document
      .querySelector("#queue-prepare")
      .onclick({ currentTarget: document.querySelector("#queue-prepare") });
    assert.equal(document.querySelectorAll(".queue-upnext").length, 1);
    await document.querySelector("[data-start]").onclick();
    assert.equal(document.querySelectorAll(".queue-live").length, 1);
    assert.equal(document.querySelectorAll("[data-win]").length, 2);
  } finally {
    Object.assign(globalThis, original);
    dom.window.close();
  }
});

test("admins can delete populated closed events and rankings are rebuilt atomically", async () => {
  const { RankingHistory } = await import("../src/models/ranking.js");
  const { TeamProposal, AuditLog, RatingHistory } =
    await import("../src/models/index.js");
  const event = await createEvent({ rated: true });
  await prepare(event, 4);
  const match = await Match.findOne({ eventId: event._id });
  assert.equal(
    (
      await call("post", `/matches/${match._id}/results`, {
        scores: [{ a: 11, b: 4 }],
        revision: 0,
      })
    ).status,
    200,
  );
  assert.equal(await RankingHistory.countDocuments({ eventId: event._id }), 4);
  assert.equal(
    (await call("delete", `/events/${event._id}`, undefined, playerCookie))
      .status,
    403,
  );
  assert.ok(await Event.exists({ _id: event._id }));
  const other = await createEvent();
  await Event.updateOne({ _id: event._id }, { status: "completed" });
  const original = Team.deleteMany;
  Team.deleteMany = async () => {
    throw new Error("Injected deletion failure");
  };
  try {
    assert.equal((await call("delete", `/events/${event._id}`)).status, 500);
  } finally {
    Team.deleteMany = original;
  }
  assert.ok(await Match.exists({ _id: match._id }));
  assert.ok(await Event.exists({ _id: event._id }));
  assert.equal((await call("delete", `/events/${event._id}`)).status, 200);
  assert.equal(await Event.findById(event._id), null);
  for (const model of [
    Match,
    Team,
    EventRegistration,
    TeamProposal,
    Tournament,
    RankingHistory,
  ])
    assert.equal(await model.countDocuments({ eventId: event._id }), 0);
  assert.equal(await RatingHistory.countDocuments({ matchId: match._id }), 0);
  assert.ok(await Event.exists({ _id: other._id }));
  assert.ok(await AuditLog.exists({ action: "delete", entityId: event._id }));
  assert.equal((await call("delete", `/events/${event._id}`)).status, 404);
});

test("Super Admin controls roles while event admins cannot manage accounts", async () => {
  const data = {
    fullName: "Event Organizer",
    username: "event_organizer",
    email: "organizer@example.test",
    phone: "+15551234567",
    password: "Organizer-password-938",
    confirmPassword: "Organizer-password-938",
    provisionalRanking: 3,
    role: "admin",
  };
  const created = await call("post", "/admin/players", data);
  assert.equal(created.status, 201);
  assert.equal(created.body.user.role, "admin");
  const organizerId = created.body.user.id;
  const organizerCookie = cookie({ _id: organizerId });
  for (const [method, path, body] of [
    ["post", "/admin/players", data],
    ["get", "/admin/users"],
    ["put", `/admin/users/${players[0]._id}/role`, { role: "super-admin" }],
    ["put", `/admin/players/${players[0]._id}/active`, { active: false }],
    ["get", "/admin/settings"],
    ["patch", "/admin/ranking/settings", {}],
  ])
    assert.equal(
      (await call(method, path, body, organizerCookie)).status,
      403,
      path,
    );
  const roster = await call(
    "get",
    "/admin/players",
    undefined,
    organizerCookie,
  );
  assert.equal(roster.status, 200);
  assert.ok(
    roster.body.players.every(
      (p) => p.role === "player" && p.email === undefined,
    ),
  );
  const template = await createEvent({ format: "random" });
  const event = await call(
    "post",
    "/events",
    { ...template, eventName: "Organizer Event" },
    organizerCookie,
  );
  assert.equal(event.status, 201, JSON.stringify(event.body));
  for (const player of players.slice(0, 4))
    assert.equal(
      (
        await call(
          "post",
          `/events/${event.body.event._id}/participants`,
          { userId: String(player._id) },
          organizerCookie,
        )
      ).status,
      200,
    );
  assert.equal(
    (
      await call(
        "post",
        `/events/${event.body.event._id}/queue/prepare`,
        {},
        organizerCookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (await call("put", `/admin/users/${admin._id}/role`, { role: "player" }))
      .status,
    400,
  );
  assert.equal(
    (await call("put", `/admin/players/${admin._id}/active`, { active: false }))
      .status,
    400,
  );
  assert.equal(
    (await call("put", `/admin/users/${organizerId}/role`, { role: "owner" }))
      .status,
    400,
  );
  assert.equal(
    (
      await call("put", `/admin/users/${organizerId}/role`, {
        role: "super-admin",
      })
    ).status,
    200,
  );
  assert.equal(
    (await call("get", "/auth/me", undefined, organizerCookie)).status,
    401,
  );
  let login = await call(
    "post",
    "/auth/login",
    { email: data.email, password: data.password },
    "",
  );
  const promotedCookie = login.headers["set-cookie"][0].split(";")[0];
  assert.equal(
    (await call("get", "/admin/users", undefined, promotedCookie)).status,
    200,
  );
  assert.equal(
    (await call("put", `/admin/users/${organizerId}/role`, { role: "player" }))
      .status,
    200,
  );
  assert.equal(
    (await call("get", "/admin/users", undefined, promotedCookie)).status,
    401,
  );
  login = await call(
    "post",
    "/auth/login",
    { email: data.email, password: data.password },
    "",
  );
  const demotedCookie = login.headers["set-cookie"][0].split(";")[0];
  assert.equal(
    (await call("post", "/events", template, demotedCookie)).status,
    403,
  );
  const { AuditLog } = await import("../src/models/index.js");
  assert.equal(
    await AuditLog.countDocuments({
      entityId: organizerId,
      action: "change-role",
    }),
    2,
  );
});

test("Super Admin migration promotes the oldest active legacy admin only once", async () => {
  const { Migration } = await import("../src/models/index.js");
  const { migrateSuperAdmin } =
    await import("../src/migrations/003-super-admin.js");
  await User.updateOne({ _id: admin._id }, { role: "admin" });
  const second = await User.create({
    fullName: "Second Admin",
    username: "second_admin",
    email: "second-admin@example.test",
    passwordHash: "unused",
    role: "admin",
    provisionalRanking: 1,
  });
  try {
    const result = await migrateSuperAdmin();
    assert.equal(result.promoted, String(admin._id));
    assert.equal((await User.findById(second._id)).role, "admin");
    assert.equal((await migrateSuperAdmin()).alreadyApplied, true);
    assert.equal((await User.findById(second._id)).role, "admin");
  } finally {
    await User.updateOne({ _id: admin._id }, { role: "super-admin" });
    await User.deleteOne({ _id: second._id });
    await Migration.deleteOne({ key: "003-super-admin" });
  }
});

test("concurrent cross-demotions retain one active Super Admin", async () => {
  const first = await User.create({
    fullName: "First Owner",
    username: "first_owner",
    email: "first-owner@example.test",
    passwordHash: "unused",
    role: "super-admin",
    provisionalRanking: 1,
  });
  const second = await User.create({
    fullName: "Second Owner",
    username: "second_owner",
    email: "second-owner@example.test",
    passwordHash: "unused",
    role: "super-admin",
    provisionalRanking: 1,
  });
  // Temporarily isolate the two owners to exercise the last-owner invariant.
  await User.updateOne({ _id: admin._id }, { role: "admin" });
  try {
    const results = await Promise.all([
      call(
        "put",
        `/admin/users/${second._id}/role`,
        { role: "admin" },
        cookie(first),
      ),
      call(
        "put",
        `/admin/users/${first._id}/role`,
        { role: "admin" },
        cookie(second),
      ),
    ]);
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.ok(results.some((r) => [401, 403, 409].includes(r.status)));
    assert.equal(
      await User.countDocuments({ role: "super-admin", active: true }),
      1,
    );
  } finally {
    await User.updateOne({ _id: admin._id }, { role: "super-admin" });
    await User.deleteMany({ _id: { $in: [first._id, second._id] } });
  }
});

test("Super Admin user management displays roles and saves role changes through the API", async () => {
  const dom = new JSDOM('<div id="app"></div><div id="announcer"></div>', {
    url: "http://localhost:3000/#/players",
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
  const original = Object.fromEntries(keys.map((k) => [k, globalThis[k]]));
  Object.assign(globalThis, {
    document: dom.window.document,
    window: dom.window,
    location: dom.window.location,
    history: dom.window.history,
    sessionStorage: dom.window.sessionStorage,
    FormData: dom.window.FormData,
    Chart: class {
      destroy() {}
    },
    lucide: { createIcons() {} },
    Swal: {
      isVisible: () => false,
      showValidationMessage(message) {
        throw new Error(message);
      },
      fire: async (options) =>
        options.input === "select"
          ? { isConfirmed: true, value: await options.preConfirm("admin") }
          : { isConfirmed: false },
    },
  });
  globalThis.fetch = async (url, options = {}) => {
    const response = await call(
      (options.method || "GET").toLowerCase(),
      url.replace(/^\/api/, ""),
      options.body ? JSON.parse(options.body) : undefined,
    );
    return {
      ok: response.status < 400,
      status: response.status,
      json: async () => response.body,
    };
  };
  try {
    await import("../public/js/app.js?super-admin-management-test");
    assert.equal(document.querySelectorAll("#new-user-role option").length, 3);
    assert.match(document.querySelector(".topbar").textContent, /SUPER ADMIN/);
    assert.equal(document.querySelector(`[data-role="${admin._id}"]`), null);
    const form = document.querySelector("#new-user-role").closest("form");
    for (const role of ["player", "admin", "super-admin"]) {
      const suffix = role.replaceAll("-", "_");
      const values = {
        fullName: `Created ${role}`,
        username: `ui_created_${suffix}`,
        email: `ui-${role}@example.test`,
        phone: "+15551234567",
        password: "Created-from-form-938",
        confirmPassword: "Created-from-form-938",
        provisionalRanking: "3",
        role,
      };
      for (const [key, value] of Object.entries(values))
        form.elements.namedItem(key).value = value;
      document.querySelector("#player-search").value = "no matching person";
      document.querySelector("#ranking-status").value = "confirmed";
      await form.onsubmit({ preventDefault() {} });
      assert.equal(form.querySelector('[role="alert"]').textContent, "");
      const stored = await User.findOne({ email: values.email });
      assert.ok(stored, `User ${role} must be saved`);
      assert.equal(stored.role, role);
      const row = document
        .querySelector(`[data-role="${stored._id}"]`)
        ?.closest("tr");
      assert.ok(row, `Created ${role} must appear immediately`);
      assert.match(
        document.querySelector("#user-save-status").textContent,
        /created successfully/,
      );
      assert.equal(document.querySelector("#user-save-status").hidden, false);
      await document
        .querySelector("#refresh-users")
        .onclick({ currentTarget: document.querySelector("#refresh-users") });
      assert.ok(
        document.querySelector(`[data-role="${stored._id}"]`),
        "Account must remain visible after refreshing the list",
      );
      assert.match(row.textContent, new RegExp(values.email));
      const refreshed = await call("get", "/admin/users");
      assert.ok(
        refreshed.body.players.some((p) => p._id === String(stored._id)),
        "Created account must persist in the refreshed list",
      );
    }
    await document.querySelector(`[data-role="${players[23]._id}"]`).onclick();
    assert.equal((await User.findById(players[23]._id)).role, "admin");
    assert.match(
      document.querySelector(`[data-role="${players[23]._id}"]`).closest("tr")
        .textContent,
      /Admin/,
    );
  } finally {
    await User.updateOne({ _id: players[23]._id }, { role: "player" });
    Object.assign(globalThis, original);
    dom.window.close();
  }
});

test("event standings count unranked wins and enabling rewards replays once with corrections", async () => {
  const { RankingHistory, PlayerRanking } =
    await import("../src/models/ranking.js");
  const event = await createEvent({ rated: false });
  await prepare(event, 4);
  const match = await Match.findOne({ eventId: event._id });
  const team = await Team.findById(match.teamA);
  assert.equal(
    (
      await call("post", `/matches/${match._id}/results`, {
        scores: [{ a: 11, b: 4 }],
        revision: 0,
      })
    ).status,
    200,
  );
  const url = `/ranking/leaderboard?period=event&eventId=${event._id}`;
  let standings = (await call("get", url)).body.rows;
  const winnerId = String(team.players[0]);
  assert.equal(standings.find((p) => p.playerId === winnerId).totalWins, 1);
  assert.equal(standings.find((p) => p.playerId === winnerId).totalStars, 0);
  assert.equal(
    (
      await call(
        "post",
        `/events/${event._id}/enable-rankings`,
        {},
        playerCookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (await call("post", `/events/${event._id}/enable-rankings`, {})).status,
    200,
  );
  standings = (await call("get", url)).body.rows;
  const win = standings.find((p) => p.playerId === winnerId);
  assert.equal(win.totalWins, 1);
  assert.ok(win.totalStars > 0);
  assert.ok(win.eventRatingPoints > 0);
  const loser = standings.find((p) => p.totalLosses === 1);
  assert.ok(loser.eventRatingPoints < 0);
  assert.equal(await RankingHistory.countDocuments({ eventId: event._id }), 4);
  const state = (await PlayerRanking.findOne({ userId: winnerId })).state;
  await call("post", `/events/${event._id}/enable-rankings`, {});
  assert.deepEqual(
    (await PlayerRanking.findOne({ userId: winnerId })).state,
    state,
  );
  const current = await Match.findById(match._id);
  assert.equal(
    (
      await call("post", `/matches/${match._id}/results`, {
        scores: [{ a: 4, b: 11 }],
        revision: current.revision,
      })
    ).status,
    200,
  );
  standings = (await call("get", url)).body.rows;
  const corrected = standings.find((p) => p.playerId === winnerId);
  assert.equal(corrected.totalWins, 0);
  assert.equal(corrected.totalLosses, 1);
  assert.ok(corrected.eventRatingPoints < 0);
});

test("live queue results automatically award ranking stars and points in an initially unranked event", async () => {
  const { RankingHistory } = await import("../src/models/ranking.js");
  const event = await createEvent({ format: "random", rated: false });
  for (const p of players.slice(4, 8))
    await call("post", `/events/${event._id}/participants`, {
      userId: String(p._id),
    });
  const base = `/events/${event._id}/queue`;
  assert.equal((await call("post", `${base}/prepare`, {})).status, 200);
  const m = (await call("get", base)).body.next[0];
  assert.equal(m.rated, true);
  assert.equal((await Event.findById(event._id)).rated, true);
  await call("post", `${base}/${m._id}/start`, { court: "1" });
  // Also cover games queued by the previous app version with ranking disabled.
  await Match.updateOne({ _id: m._id }, { rated: false });
  await Event.updateOne({ _id: event._id }, { rated: false });
  assert.equal(
    (
      await call("post", `/matches/${m._id}/results`, {
        scores: [{ a: 11, b: 5 }],
        revision: 0,
      })
    ).status,
    200,
  );
  assert.equal(await RankingHistory.countDocuments({ eventId: event._id }), 4);
  const standings = (
    await call("get", `/ranking/leaderboard?period=event&eventId=${event._id}`)
  ).body.rows;
  assert.equal(
    standings.filter(
      (p) => p.totalWins === 1 && p.totalStars > 0 && p.eventRatingPoints > 0,
    ).length,
    2,
  );
  assert.equal(
    standings.filter((p) => p.totalLosses === 1 && p.eventRatingPoints < 0)
      .length,
    2,
  );
  assert.equal((await call("get", base)).body.waiting.length, 4);
});
