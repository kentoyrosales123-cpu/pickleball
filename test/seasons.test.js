import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { seasonCountdown, mountSeasons } from "../public/js/seasons.js";
import { replayRanking } from "../src/domain/ranking.js";

test("full star reset preserves MMR and lifetime records", () => {
  const entries = [
    {
      id: "game",
      kind: "match",
      timestamp: 1,
      teamA: ["a", "b"],
      teamB: ["c", "d"],
      wonA: true,
    },
  ];
  const before = replayRanking(["a", "b", "c", "d"], entries).states.get("a");
  const after = replayRanking(
    ["a", "b", "c", "d"],
    [
      ...entries,
      { id: "new", kind: "season", timestamp: 2, resetPolicy: "full" },
    ],
  ).states.get("a");
  assert.equal(after.rankStars, 0);
  assert.equal(after.mmr, before.mmr);
  assert.equal(after.rankedMatches, before.rankedMatches);
  assert.equal(after.placementCount, before.placementCount);
});

test("season countdown and archive show personal badges safely", async (t) => {
  assert.equal(seasonCountdown(new Date(90061000), 0), "1d 1h 1m 1s remaining");
  assert.match(seasonCountdown(new Date(0), 1), /Season ended/);
  const dom = new JSDOM("<main></main>");
  t.after(() => dom.window.close());
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => ({
      archived: true,
      rows: [
        {
          playerId: "p",
          fullName: "<script>bad</script>",
          position: 1,
          wins: 2,
          losses: 1,
          finalStars: 4,
          highestStars: 5,
          finalRank: { rankTier: "Rookie", rankDivision: "III" },
          highestRank: { rankTier: "Rookie", rankDivision: "II" },
          badges: ["Season champion"],
        },
      ],
    }),
  }));
  const main = dom.window.document.querySelector("main");
  const cleanup = await mountSeasons(
    main,
    [
      {
        _id: "s",
        name: "First season",
        status: "closed",
        startDate: new Date(0),
        endDate: new Date(1),
      },
    ],
    "p",
  );
  t.after(cleanup);
  assert.match(main.textContent, /Your season:/);
  assert.match(main.textContent, /Season champion/);
  assert.equal(main.querySelector("script"), null);
  main.querySelector("select").value = "";
  await main.querySelector("select").onchange();
  assert.match(main.textContent, /Choose a season to see/);
});
