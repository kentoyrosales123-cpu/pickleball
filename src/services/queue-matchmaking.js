import { shuffle, generateTeams } from "./teams.js";

const id = (player) => String(player._id ?? player);
const pairKey = (a, b) => [id(a), id(b)].sort().join(":");

// Queue priority selects the four players. Only their team split is optimized.
export function generateQueueTeams(players, history = []) {
  if (players.length !== 4 || new Set(players.map(id)).size !== 4)
    throw new Error("Four distinct players are required for a queue match");
  const partners = new Map();
  const opponents = new Map();
  const played = history
    .filter((match) => match.matchStatus === "finalized")
    .sort((a, b) => +new Date(a.completedAt) - +new Date(b.completedAt));
  const add = (counts, a, b, weight) => {
    const key = pairKey(a, b);
    counts.set(key, (counts.get(key) || 0) + weight);
  };
  played.forEach((match, index) => {
    // Count every meeting, with an extra penalty for recent meetings.
    const weight = 1 + 1 / (played.length - index);
    const a = match.teamA.players;
    const b = match.teamB.players;
    add(partners, a[0], a[1], weight);
    add(partners, b[0], b[1], weight);
    for (const p of a) for (const q of b) add(opponents, p, q, weight);
  });
  const [a, b, c, d] = players;
  const candidates = shuffle([
    [
      [a, b],
      [c, d],
    ],
    [
      [a, c],
      [b, d],
    ],
    [
      [a, d],
      [b, c],
    ],
  ]).map((teams) => ({
    teams,
    partners: teams.reduce(
      (sum, pair) => sum + (partners.get(pairKey(...pair)) || 0),
      0,
    ),
    opponents: teams[0].reduce(
      (sum, p) =>
        sum +
        teams[1].reduce(
          (total, q) => total + (opponents.get(pairKey(p, q)) || 0),
          0,
        ),
      0,
    ),
  }));
  candidates.sort(
    (a, b) => a.partners - b.partners || a.opponents - b.opponents,
  );
  return {
    teams: shuffle(candidates[0].teams).map(
      (pair) => generateTeams(pair, "random").teams[0],
    ),
    unassigned: [],
  };
}
