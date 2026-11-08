import test from "node:test";
import assert from "node:assert/strict";
import {
  generateTeams,
  roundRobin,
  scheduleRounds,
} from "../src/services/teams.js";
import { scoreMatch } from "../src/services/scoring.js";
import { eliminationNodes } from "../src/services/brackets.js";
const players = Array.from({ length: 24 }, (_, i) => ({
  _id: String(i),
  provisionalRanking: Math.floor(i / 2) + 1,
}));
test("all team modes assign each player once and leave only an odd substitute", () => {
  for (const mode of ["random", "balanced", "same-rank"])
    for (let n = 2; n <= 24; n++) {
      const result = generateTeams(players.slice(0, n), mode);
      const assigned = result.teams.flatMap((t) => t.players);
      assert.equal(new Set(assigned).size, assigned.length);
      assert.equal(assigned.length + result.unassigned.length, n);
      assert.equal(result.unassigned.length, n % 2);
    }
});
test("balanced optimization reduces team strength spread and remains randomized", () => {
  const outputs = new Set();
  for (let i = 0; i < 12; i++) {
    const { teams } = generateTeams(players, "balanced");
    const values = teams.map((t) => t.combinedRanking);
    assert.ok(Math.max(...values) - Math.min(...values) <= 2);
    outputs.add(JSON.stringify(teams));
  }
  assert.ok(outputs.size > 1);
});
test("same-rank mode prioritizes equal ranks", () => {
  const { teams } = generateTeams(players, "same-rank");
  assert.ok(
    teams.every(
      (t) =>
        Math.abs(
          players[+t.players[0]].provisionalRanking -
            players[+t.players[1]].provisionalRanking,
        ) <= 1,
    ),
  );
});
test("round robin includes every pair exactly once without conflicts", () => {
  for (const n of [2, 3, 4, 7, 12]) {
    const teams = players.slice(0, n);
    const rounds = roundRobin(teams);
    const pairs = rounds.flat().map((p) =>
      p
        .map((t) => t._id)
        .sort()
        .join(":"),
    );
    assert.equal(pairs.length, (n * (n - 1)) / 2);
    assert.equal(new Set(pairs).size, pairs.length);
    for (const round of rounds) {
      const ids = round.flat().map((t) => t._id);
      assert.equal(new Set(ids).size, ids.length);
    }
  }
});
test("court schedule never overlaps a team or court and respects end time", () => {
  const event = {
    _id: "event",
    courts: ["1", "2"],
    matchDuration: 20,
    startDateTime: new Date("2026-01-01T00:00Z"),
    endDateTime: new Date("2026-01-02T00:00Z"),
  };
  const matches = scheduleRounds(roundRobin(players.slice(0, 6)), event);
  for (const start of new Set(matches.map((m) => +m.startDateTime))) {
    const slot = matches.filter((m) => +m.startDateTime === start);
    assert.equal(new Set(slot.map((m) => m.courtNumber)).size, slot.length);
    assert.equal(
      new Set(slot.flatMap((m) => [m.teamA, m.teamB])).size,
      slot.length * 2,
    );
  }
  assert.throws(() =>
    scheduleRounds(roundRobin(players), {
      ...event,
      endDateTime: event.startDateTime,
    }),
  );
});
test("scoring validates deuce, winning margin, best of three, and rejects impossible final scores", () => {
  const rules = { targetPoints: 11, winningMargin: 2, bestOf: 1 };
  assert.equal(scoreMatch([{ a: 11, b: 0 }], rules), "A");
  assert.equal(scoreMatch([{ a: 11, b: 13 }], rules), "B");
  for (const scores of [
    [{ a: 11, b: 10 }],
    [{ a: 12, b: 5 }],
    [{ a: 0, b: 0 }],
    [{ a: -1, b: 11 }],
    [{ a: 11.5, b: 9 }],
  ])
    assert.throws(() => scoreMatch(scores, rules));
  assert.equal(
    scoreMatch(
      [
        { a: 11, b: 9 },
        { a: 8, b: 11 },
        { a: 15, b: 13 },
      ],
      { ...rules, bestOf: 3 },
    ),
    "A",
  );
  assert.throws(() => scoreMatch([{ a: 11, b: 0 }], { ...rules, bestOf: 3 }));
  assert.throws(() =>
    scoreMatch(
      [
        { a: 11, b: 0 },
        { a: 11, b: 0 },
        { a: 0, b: 11 },
      ],
      { ...rules, bestOf: 3 },
    ),
  );
});
test("double elimination topology resolves without phantom opponents for sizes 2 through 24", () => {
  for (let count = 2; count <= 24; count++) {
    const nodes = eliminationNodes(players.slice(0, count), true);
    const resolved = new Map();
    const losses = new Map();
    const source = (s) => {
      if (s === "BYE") return null;
      const [kind, key] = s.split(":");
      if (kind === "T") return key;
      const r = resolved.get(key);
      assert.ok(r, `Missing ${key} in size ${count}`);
      return kind === "W" ? r.winner : r.loser;
    };
    for (const node of nodes) {
      const [a, b] = node.sources.map(source);
      assert.ok(!a || a !== b);
      const winner = a ?? b;
      const loser = a && b ? b : null;
      if (loser) losses.set(loser, (losses.get(loser) || 0) + 1);
      resolved.set(node.bracketKey, { winner, loser });
    }
    const champ = resolved.get("GF").winner;
    assert.ok(champ != null);
    for (const p of players.slice(0, count))
      if (p._id !== champ)
        assert.equal(losses.get(p._id), 2, `Player ${p._id}, size ${count}`);
  }
});
