import test from "node:test";
import assert from "node:assert/strict";
import {
  rankFor,
  initialRanking,
  applyOutcome,
  balancedFour,
  replayRanking,
} from "../src/domain/ranking.js";
const play = (state, won, own = 1000, other = 1000) =>
  applyOutcome({ ...initialRanking(), ...state }, won, own, other);
test("star wins, losses, floor and hidden MMR direction", () => {
  const win = play({}, true),
    loss = play({ rankStars: 3 }, false),
    floor = play({}, false);
  assert.equal(win.state.rankStars, 1);
  assert.equal(loss.state.rankStars, 2);
  assert.equal(floor.state.rankStars, 0);
  assert.equal(win.state.mmr, 1020);
  assert.equal(loss.state.mmr, 980);
});
test("protection and double-star thresholds preserve excess reward points", () => {
  const loss = play({ rankStars: 5, protectionPoints: 85 }, false);
  assert.equal(loss.state.protectionPoints, 5);
  assert.equal(loss.state.rankStars, 5);
  assert.ok(loss.protectionActivated);
  const win = play({ doubleStarPoints: 90 }, true);
  assert.equal(win.state.doubleStarPoints, 10);
  assert.equal(win.state.rankStars, 2);
  assert.ok(win.doubleStarActivated);
  assert.equal(play({}, true, 1000, 1150).state.doubleStarPoints, 30);
  assert.equal(play({}, false, 1000, 1149).state.protectionPoints, 20);
});
test("division promotion, demotion, multiple stars and unlimited Legend", () => {
  assert.deepEqual(
    [rankFor(0).rankTier, rankFor(0).rankDivision],
    ["Rookie", "III"],
  );
  assert.equal(play({ rankStars: 4 }, true).state.rankDivision, "II");
  assert.ok(play({ rankStars: 4 }, true).rankPromoted);
  assert.equal(play({ rankStars: 5 }, false).state.rankDivision, "III");
  assert.ok(play({ rankStars: 5 }, false).rankDemoted);
  assert.equal(
    play({ rankStars: 14, doubleStarPoints: 80 }, true).state.rankTier,
    "Bronze",
  );
  assert.equal(rankFor(134).rankTier, "Grandmaster");
  assert.equal(rankFor(135).rankTier, "Legend");
  assert.equal(rankFor(250).stars, 115);
  assert.throws(() => rankFor(-1));
  assert.throws(() => rankFor(0.5));
});
test("each teammate uses own placement K with pre-match team expectation", () => {
  assert.equal(play({ placementCount: 9 }, true).kFactor, 40);
  assert.equal(play({ placementCount: 10 }, true).kFactor, 24);
  assert.equal(play({ placementCount: 10 }, true).mmrChanged, 12);
  const r = replayRanking(
    ["a", "b", "c", "d"],
    [
      {
        kind: "match",
        id: "m",
        timestamp: new Date(),
        teamA: ["a", "b"],
        teamB: ["c", "d"],
        wonA: true,
      },
    ],
  );
  assert.equal(r.states.get("a").mmr, r.states.get("b").mmr);
  assert.equal(r.history.length, 4);
});
test("all three doubles pairings evaluated with balanced sample and no duplicate players", () => {
  const p = [1200, 1100, 950, 850].map((mmr, i) => ({ _id: String(i), mmr }));
  const best = balancedFour(p);
  assert.equal(best.gap, 0);
  assert.deepEqual(best.teamA, ["0", "3"]);
  assert.throws(() => balancedFour([p[0], p[0], p[2], p[3]]));
});
test("season reset preserves lifetime statistics and placement recalibration", () => {
  const entries = [
    { kind: "adjustment", id: "a", playerId: "p", rankStars: 30, timestamp: 1 },
    {
      kind: "season",
      id: "s",
      timestamp: 2,
      resetPolicy: "partial",
      keepFraction: 0.5,
    },
    { kind: "season", id: "t", timestamp: 3, resetPolicy: "placement" },
  ];
  const { states, snapshots } = replayRanking(["p"], entries);
  assert.equal(snapshots.find((s) => s.seasonId === "s").state.rankStars, 15);
  assert.equal(states.get("p").rankStars, 0);
  assert.equal(states.get("p").highestRank, 30);
});
