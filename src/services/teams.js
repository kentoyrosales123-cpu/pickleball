import { balancedFour } from "../domain/ranking.js";
import { randomInt } from "node:crypto";
import { numericalRating } from "../domain/ratings.js";
export function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const pairKey = (a, b) => [String(a._id), String(b._id)].sort().join(":");
export function generateTeams(players, mode = "balanced", previous = []) {
  if (!["random", "balanced", "same-rank"].includes(mode))
    throw new Error("Unsupported automatic team mode");
  if (
    mode === "balanced" &&
    players.length === 4 &&
    players.every((p) => p.$locals?.rankingMMR !== undefined)
  ) {
    const best = balancedFour(
      players.map((p) => ({ _id: p._id, mmr: numericalRating(p) })),
      previous,
    );
    return {
      teams: [best.teamA, best.teamB].map((ids) => ({
        players: ids,
        combinedRanking: ids.reduce((sum, id) => {
          const p = players.find((p) => String(p._id) === String(id));
          return sum + (p.officialRanking || p.provisionalRanking);
        }, 0),
        combinedRating: ids.reduce(
          (sum, id) =>
            sum +
            numericalRating(players.find((p) => String(p._id) === String(id))),
          0,
        ),
      })),
      unassigned: [],
    };
  }
  const pool = shuffle(players);
  const unassigned = pool.length % 2 ? [pool.pop()] : [];
  const rank = (p) => p.officialRanking || p.provisionalRanking;
  const old = new Set(previous.map((p) => p.map(String).sort().join(":")));
  const score = (teams) => {
    if (!teams.length) return 0;
    const strengths = teams.map(
      (t) => (numericalRating(t[0]) + numericalRating(t[1])) / 200,
    );
    const mean = strengths.reduce((a, b) => a + b, 0) / strengths.length;
    return teams.reduce(
      (n, t, i) =>
        n +
        (mode === "same-rank"
          ? Math.abs(rank(t[0]) - rank(t[1])) * 100
          : (strengths[i] - mean) ** 2) +
        (old.has(pairKey(...t)) ? 2 : 0),
      0,
    );
  };
  let best = [];
  for (let i = 0; i < pool.length; i += 2) best.push([pool[i], pool[i + 1]]);
  if (mode !== "random") {
    let cost = score(best);
    for (
      let iteration = 0;
      iteration < Math.max(300, pool.length * 80);
      iteration++
    ) {
      if (best.length < 2) break;
      const next = best.map((t) => [...t]);
      const a = randomInt(next.length),
        b = randomInt(next.length),
        x = randomInt(2),
        y = randomInt(2);
      if (a === b) continue;
      [next[a][x], next[b][y]] = [next[b][y], next[a][x]];
      const value = score(next);
      if (value <= cost) {
        best = next;
        cost = value;
      }
    }
  }
  return {
    teams: best.map((players) => ({
      players: players.map((p) => p._id),
      combinedRanking: players.reduce((s, p) => s + rank(p), 0),
      combinedRating: players.reduce((s, p) => s + numericalRating(p), 0),
    })),
    unassigned: unassigned.map((p) => p._id),
  };
}
export function roundRobin(teams) {
  const ring = [...teams];
  if (ring.length % 2) ring.push(null);
  const rounds = [];
  for (let r = 0; r < ring.length - 1; r++) {
    const pairs = [];
    for (let i = 0; i < ring.length / 2; i++)
      if (ring[i] && ring[ring.length - 1 - i])
        pairs.push([ring[i], ring[ring.length - 1 - i]]);
    rounds.push(pairs);
    ring.splice(1, 0, ring.pop());
  }
  return rounds;
}
export function rotatingMatchups(teams, history = []) {
  const seen = new Map();
  for (const [a, b] of history)
    for (const p of a.players)
      for (const q of b.players) {
        const key = [String(p), String(q)].sort().join(":");
        seen.set(key, (seen.get(key) || 0) + 1);
      }
  const cost = (pairs) =>
    pairs.reduce(
      (sum, [a, b]) =>
        sum +
        a.players.reduce(
          (n, p) =>
            n +
            b.players.reduce(
              (v, q) =>
                v +
                (seen.get([String(p), String(q)].sort().join(":")) || 0) * 100,
              0,
            ),
          0,
        ) +
        Math.abs(
          (a.combinedRating ?? a.combinedRanking * 200) -
            (b.combinedRating ?? b.combinedRanking * 200),
        ) /
          200,
      0,
    );
  let best = [],
    minimum = Infinity;
  for (let i = 0; i < 120; i++) {
    const ordered = shuffle(teams),
      pairs = [];
    for (let j = 0; j + 1 < ordered.length; j += 2)
      pairs.push([ordered[j], ordered[j + 1]]);
    const score = cost(pairs);
    if (score < minimum) {
      best = pairs;
      minimum = score;
    }
  }
  return best;
}
export function scheduleRounds(rounds, event) {
  const matches = [];
  let slot = 0;
  rounds.forEach((pairs, r) => {
    pairs.forEach(([a, b], i) =>
      matches.push({
        eventId: event._id,
        roundNumber: r + 1,
        courtNumber: event.courts[i % event.courts.length],
        teamA: a._id,
        teamB: b._id,
        startDateTime: new Date(
          +event.startDateTime +
            (slot + Math.floor(i / event.courts.length)) *
              event.matchDuration *
              60_000,
        ),
      }),
    );
    slot += Math.ceil(pairs.length / event.courts.length);
  });
  if (
    +event.startDateTime + slot * event.matchDuration * 60_000 >
    +event.endDateTime
  )
    throw new Error(
      "Schedule exceeds the event end time. Extend the event or reduce rounds.",
    );
  return matches;
}

export function reserveCourt(
  event,
  matches,
  teamA,
  teamB,
  earliest = +event.startDateTime,
) {
  const duration = event.matchDuration * 60_000;
  const start =
    +event.startDateTime +
    Math.ceil((earliest - +event.startDateTime) / duration) * duration;
  const teams = new Set([String(teamA), String(teamB)]);
  for (
    let time = start;
    time + duration <= +event.endDateTime;
    time += duration
  ) {
    const overlap = matches.filter(
      (m) =>
        m.startDateTime &&
        +m.startDateTime < time + duration &&
        +m.startDateTime + duration > time,
    );
    if (
      overlap.some((m) =>
        [m.teamA, m.teamB].some((id) => teams.has(String(id))),
      )
    )
      continue;
    const court = event.courts.find(
      (c) => !overlap.some((m) => m.courtNumber === c),
    );
    if (court) return { startDateTime: new Date(time), courtNumber: court };
  }
  throw new Error("No available court slot within the event window");
}
