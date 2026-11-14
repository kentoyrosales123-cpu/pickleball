import test from "node:test";
import assert from "node:assert/strict";
import { generateQueueTeams } from "../src/services/queue-matchmaking.js";

const players = ["a", "b", "c", "d"].map((_id) => ({
  _id,
  provisionalRanking: 2,
  doublesRating: 1000,
}));
const match = (a, b, completedAt = 1000, matchStatus = "finalized") => ({
  teamA: { players: a },
  teamB: { players: b },
  completedAt,
  matchStatus,
});
const pairs = (draft) =>
  draft.teams.map((t) => [...t.players].sort().join("")).sort();

test("queue cycles through all partnerships before repeating with four players", () => {
  const history = [];
  const seen = new Set();
  for (let round = 0; round < 3; round++) {
    const draft = generateQueueTeams(players, history);
    assert.deepEqual(draft.teams.flatMap((t) => t.players).sort(), [
      "a",
      "b",
      "c",
      "d",
    ]);
    for (const pair of pairs(draft)) {
      assert.ok(!seen.has(pair), `Repeated partnership ${pair}`);
      seen.add(pair);
    }
    assert.equal(draft.teams[0].combinedRanking, 4);
    assert.ok(Number.isFinite(draft.teams[0].combinedRating));
    history.push(
      match(draft.teams[0].players, draft.teams[1].players, (round + 1) * 1000),
    );
  }
  assert.equal(seen.size, 6);
  assert.equal(generateQueueTeams(players, history).teams.length, 2);
});

test("queue reduces repeated opponents when partnership costs are equal", () => {
  const history = [match(["a", "x"], ["b", "y"])];
  for (let i = 0; i < 10; i++)
    assert.deepEqual(pairs(generateQueueTeams(players, history)), ["ab", "cd"]);
});

test("queue prefers older partnerships when every combination has been played", () => {
  const history = [
    match(["a", "d"], ["b", "c"], 3000),
    match(["a", "b"], ["c", "d"], 1000),
    match(["a", "c"], ["b", "d"], 2000),
  ];
  assert.deepEqual(pairs(generateQueueTeams(players, history)), ["ab", "cd"]);
  assert.equal(history[0].completedAt, 3000);
});

test("unplayed matches do not affect matchup history and populated players are supported", () => {
  const history = [
    match([{ _id: "a" }, { _id: "x" }], [{ _id: "b" }, { _id: "y" }]),
    match(["a", "b"], ["c", "d"], 2000, "pending"),
    match(["a", "b"], ["c", "d"], 3000, "scheduled"),
    match(["a", "b"], ["c", "d"], 4000, "cancelled"),
  ];
  assert.deepEqual(pairs(generateQueueTeams(players, history)), ["ab", "cd"]);
});

test("queue matchmaking requires four distinct players", () => {
  assert.throws(() => generateQueueTeams(players.slice(0, 3)), /Four distinct/);
  assert.throws(
    () => generateQueueTeams([players[0], ...players.slice(0, 3)]),
    /Four distinct/,
  );
});
