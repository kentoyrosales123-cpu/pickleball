import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RATING_POLICY as defaults,
  seedRating,
  doublesAdjustment,
  categoryWithHysteresis,
  replayRatings,
} from "../src/domain/ratings.js";
import { generateTeams } from "../src/services/teams.js";
import { ratingSettingsSchema } from "../src/controllers/ratings.js";
const policy = { ...defaults, enabled: true };
const baseline = (id, rank = 1) => ({
  playerId: id,
  baselineRating: seedRating(rank),
  baselineRank: rank,
  baselineRankingStatus: "provisional",
});
const base = ["a", "b", "c", "d", "e", "f"].map((id) => baseline(id));
const match = (
  id,
  wonA = true,
  offset = 0,
  players = ["a", "b", "c", "d"],
) => ({
  id,
  kind: "match",
  teamA: players.slice(0, 2),
  teamB: players.slice(2),
  wonA,
  policy,
  timestamp: new Date(1700000000000 + offset),
});

test("doubles Elo uses team averages, equal partner adjustments, and zero-sum transfers", () => {
  const equal = doublesAdjustment([1000, 1000], [1000, 1000], true);
  assert.equal(equal.expectedA, 0.5);
  assert.equal(equal.adjustmentA, 16);
  assert.equal(equal.adjustmentB, -16);
  const mixed = doublesAdjustment([800, 1200], [1000, 1000], false, 64);
  assert.equal(mixed.adjustmentA, -32);
  const favorite = doublesAdjustment([1400, 1400], [1000, 1000], true);
  assert.ok(Math.abs(favorite.expectedA - 10 / 11) < 1e-12);
  assert.ok(favorite.adjustmentA < 3);
  assert.equal(favorite.adjustmentA * 2 + favorite.adjustmentB * 2, 0);
  assert.throws(() => doublesAdjustment([100], [100, 100], true));
  assert.throws(() => doublesAdjustment([NaN, 100], [100, 100], true));
});
test("12 categories have a 20-point hysteresis deadband and bounded category numbers", () => {
  assert.equal(categoryWithHysteresis(219.999, 1), 1);
  assert.equal(categoryWithHysteresis(220, 1), 2);
  assert.equal(categoryWithHysteresis(180, 2), 2);
  assert.equal(categoryWithHysteresis(179.999, 2), 1);
  assert.equal(categoryWithHysteresis(-500, 1), 1);
  assert.equal(categoryWithHysteresis(9000, 1), 12);
  assert.equal(categoryWithHysteresis(100, 12), 1);
  const custom = {
    ...policy,
    promotionThresholds: policy.promotionThresholds.map((v) => v + 50),
    demotionThresholds: policy.demotionThresholds.map((v) => v - 50),
  };
  assert.equal(categoryWithHysteresis(269, 1, custom), 1);
  assert.equal(categoryWithHysteresis(270, 1, custom), 2);
  assert.equal(categoryWithHysteresis(129, 2, custom), 1);
});
test("automatic skill category cannot be confirmed before ten rated matches", () => {
  const timeline = Array.from({ length: 10 }, (_, i) =>
    match(String(i), true, i),
  );
  const nine = replayRatings(base, timeline.slice(0, 9)).states.find(
    (p) => p.playerId === "a",
  );
  assert.equal(nine.automaticConfirmed, false);
  assert.equal(nine.officialRanking, undefined);
  assert.equal(nine.rank, 1);
  const ten = replayRatings(base, timeline).states.find(
    (p) => p.playerId === "a",
  );
  assert.equal(ten.matches, 10);
  assert.equal(ten.automaticConfirmed, true);
  assert.equal(ten.officialRanking, 1);
  const promoted = replayRatings(
    base,
    Array.from({ length: 12 }, (_, i) => match(String(i), true, i)),
  ).states.find((p) => p.playerId === "a");
  assert.equal(promoted.rank, 2);
});
test("chronological replay propagates a correction through later partners and opponents", () => {
  const first = match("first", true, 0),
    later = match("later", true, 1000, ["a", "e", "c", "f"]);
  const original = replayRatings(base, [later, first]);
  const corrected = replayRatings(base, [later, { ...first, wonA: false }]);
  const p = (r, id) => r.states.find((p) => p.playerId === id);
  assert.notEqual(p(original, "e").rating, p(corrected, "e").rating);
  assert.notEqual(p(original, "f").rating, p(corrected, "f").rating);
  assert.deepEqual(
    corrected,
    replayRatings(base, [{ ...first, wonA: false }, later]),
  );
  const removed = replayRatings(base, [later]);
  assert.equal(p(removed, "e").rating, 116);
  assert.equal(p(removed, "b").matches, 0);
});
test("manual decisions are replayable anchors; releasing an override resumes automatic categories", () => {
  const override = {
    id: "override",
    kind: "override",
    playerId: "a",
    action: "manual",
    rank: 6,
    rating: 1100,
    reason: "Club assessment",
    policy,
    timestamp: new Date(1700000000500),
  };
  const later = Array.from({ length: 10 }, (_, i) =>
    match(`next-${i}`, false, 1000 + i),
  );
  const locked = replayRatings(base, [match("first"), override, ...later]);
  const a = locked.states.find((p) => p.playerId === "a");
  assert.equal(a.manualLocked, true);
  assert.equal(a.rank, 6);
  assert.ok(a.rating < 1100);
  const corrected = replayRatings(base, [
    match("first", false),
    override,
    ...later,
  ]);
  assert.equal(
    corrected.history.find((h) => h.overrideId === "override").newRating,
    1100,
  );
  const released = replayRatings(base, [
    match("first"),
    override,
    ...later,
    {
      ...override,
      id: "release",
      action: "release",
      timestamp: new Date(1700000010000),
    },
  ]);
  assert.equal(
    released.states.find((p) => p.playerId === "a").manualLocked,
    false,
  );
  assert.equal(locked.history.filter((h) => h.kind === "match").length, 44);
});
test("historical K-factors are replayed per result instead of using current settings", () => {
  const entries = [
    match("one"),
    { ...match("two", true, 1), policy: { ...policy, kFactor: 64 } },
  ];
  const result = replayRatings(base, entries);
  const second = result.history.find(
    (h) => h.matchId === "two" && h.playerId === "a",
  );
  assert.equal(second.kFactor, 64);
  assert.equal(second.previousRating, 116);
  assert.ok(second.adjustment > 28);
  assert.deepEqual(result, replayRatings(base, entries));
});
test("rating settings reject unsafe or inconsistent thresholds and minimums below ten", () => {
  assert.equal(ratingSettingsSchema.safeParse(policy).success, true);
  for (const invalid of [
    { ...policy, minimumRatedMatches: 9 },
    { ...policy, kFactor: 0 },
    { ...policy, promotionThresholds: [200] },
    {
      ...policy,
      demotionThresholds: policy.demotionThresholds.map((v) => v + 1),
    },
    { ...policy, promotionThresholds: Array(11).fill(500) },
  ])
    assert.equal(ratingSettingsSchema.safeParse(invalid).success, false);
});
test("balanced doubles teams use numerical Elo even when all skill categories are identical", () => {
  const players = [100, 200, 300, 400, 900, 1000, 1100, 1200].map(
    (doublesRating, i) => ({
      _id: String(i),
      provisionalRanking: 1,
      doublesRating,
    }),
  );
  const { teams } = generateTeams(players, "balanced");
  assert.ok(teams.every((t) => t.combinedRanking === 2));
  assert.ok(teams.every((t) => t.combinedRating === 1300));
});
