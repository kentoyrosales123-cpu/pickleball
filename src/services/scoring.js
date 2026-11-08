import { ensure } from "../middleware/security.js";
export function scoreMatch(scores, rules) {
  ensure(
    Array.isArray(scores) && scores.length > 0 && scores.length <= rules.bestOf,
    "Invalid number of games",
  );
  let a = 0,
    b = 0;
  const needed = Math.ceil(rules.bestOf / 2);
  for (const game of scores) {
    ensure(a < needed && b < needed, "Extra game after match was decided");
    ensure(
      Number.isInteger(game.a) &&
        Number.isInteger(game.b) &&
        game.a >= 0 &&
        game.b >= 0 &&
        game.a <= 999 &&
        game.b <= 999,
      "Scores must be nonnegative integers below 1000",
    );
    const high = Math.max(game.a, game.b),
      low = Math.min(game.a, game.b);
    ensure(
      high >= rules.targetPoints && high - low >= rules.winningMargin,
      "Winning score does not meet target and margin",
    );
    ensure(
      high === rules.targetPoints || high - low === rules.winningMargin,
      "Game should have ended at an earlier score",
    );
    if (game.a > game.b) a++;
    else b++;
  }
  ensure(a === needed || b === needed, "Match is not complete");
  return a > b ? "A" : "B";
}
