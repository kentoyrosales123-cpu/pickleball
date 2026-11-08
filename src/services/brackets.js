import { Match, Tournament } from "../models/index.js";
import { shuffle, roundRobin, reserveCourt } from "./teams.js";
import { ensure } from "../middleware/security.js";
export function eliminationNodes(teams, double = false, prefix = "") {
  const size = 2 ** Math.ceil(Math.log2(teams.length));
  const rounds = Math.log2(size);
  const nodes = [];
  const first = [];
  // Seed order distributes byes so no real team is stranded behind an empty branch.
  let seeds = [1, 2];
  for (let n = 4; n <= size; n *= 2)
    seeds = seeds.flatMap((s) => [s, n + 1 - s]);
  const source = (seed) =>
    teams[seed - 1] ? `T:${teams[seed - 1]._id}` : "BYE";
  for (let r = 1; r <= rounds; r++)
    for (let i = 0; i < size / 2 ** r; i++) {
      const key = `${prefix}W${r}-${i}`;
      const sources =
        r === 1
          ? [source(seeds[2 * i]), source(seeds[2 * i + 1])]
          : [
              `W:${prefix}W${r - 1}-${2 * i}`,
              `W:${prefix}W${r - 1}-${2 * i + 1}`,
            ];
      nodes.push({
        bracketKey: key,
        sources,
        roundNumber: r,
        stage: "winners",
      });
      if (r === 1) first.push(key);
    }
  if (!double) return nodes;
  if (size === 2) {
    nodes.push({
      bracketKey: "GF",
      sources: ["W:W1-0", "L:W1-0"],
      roundNumber: 2,
      stage: "final",
    });
    return nodes;
  }
  for (let i = 0; i < size / 4; i++)
    nodes.push({
      bracketKey: `L1-${i}`,
      sources: [`L:${first[2 * i]}`, `L:${first[2 * i + 1]}`],
      roundNumber: 2,
      stage: "losers",
    });
  for (let wr = 2; wr <= rounds; wr++) {
    const lr = 2 * wr - 2,
      count = size / 2 ** wr;
    for (let i = 0; i < count; i++)
      nodes.push({
        bracketKey: `L${lr}-${i}`,
        sources: [`W:L${lr - 1}-${i}`, `L:W${wr}-${count > 1 ? i ^ 1 : i}`],
        roundNumber: lr + 1,
        stage: "losers",
      });
    if (wr < rounds)
      for (let i = 0; i < count / 2; i++)
        nodes.push({
          bracketKey: `L${lr + 1}-${i}`,
          sources: [`W:L${lr}-${2 * i}`, `W:L${lr}-${2 * i + 1}`],
          roundNumber: lr + 2,
          stage: "losers",
        });
  }
  nodes.push({
    bracketKey: "GF",
    sources: [`W:W${rounds}-0`, `W:L${2 * rounds - 2}-0`],
    roundNumber: 2 * rounds,
    stage: "final",
  });
  return nodes;
}
export async function buildBracket(event, teams, session) {
  ensure(teams.length >= 2, "At least two teams are required");
  const ordered = shuffle(teams);
  let nodes;
  if (event.format === "round-robin" || event.format === "group-knockout") {
    const count =
      event.format === "round-robin"
        ? 1
        : Math.min(event.groupCount, Math.floor(teams.length / 2));
    const groups = Array.from({ length: count }, () => []);
    ordered.forEach((t, i) => groups[i % count].push(t));
    nodes = groups.flatMap((group, g) =>
      roundRobin(group).flatMap((pairs, r) =>
        pairs.map(([a, b], i) => ({
          bracketKey: `G${g}-${r}-${i}`,
          sources: [`T:${a._id}`, `T:${b._id}`],
          stage: `group-${g}`,
          roundNumber: r + 1,
        })),
      ),
    );
  } else
    nodes = eliminationNodes(ordered, event.format === "double-elimination");
  let maximumMatches =
    nodes.length +
    (event.format === "double-elimination" && event.grandFinalReset ? 1 : 0);
  if (event.format === "group-knockout")
    maximumMatches +=
      Math.min(event.groupCount, Math.floor(teams.length / 2)) * 2 - 1;
  ensure(
    +event.startDateTime + maximumMatches * event.matchDuration * 60_000 <=
      +event.endDateTime,
    "Tournament window is too short for the conservative schedule. Extend the event end time or shorten matches.",
  );
  await Tournament.findOneAndUpdate(
    { eventId: event._id },
    {
      bracketType: event.format,
      bracketData: { generatedAt: new Date() },
      standings: [],
      $unset: { champion: 1 },
    },
    { upsert: true, session },
  );
  await Match.insertMany(
    nodes.map((n) => ({
      ...n,
      eventId: event._id,
      matchStatus: "pending",
      rated: event.rated,
    })),
    { session },
  );
  await advanceBracket(event, session);
}
export function standings(matches) {
  const rows = new Map();
  for (const m of matches) {
    for (const id of [m.teamA, m.teamB].filter(Boolean))
      if (!rows.has(String(id)))
        rows.set(String(id), {
          team: String(id),
          wins: 0,
          losses: 0,
          points: 0,
          conceded: 0,
        });
    if (m.matchStatus !== "finalized") continue;
    for (const [id, other, side] of [
      [m.teamA, m.teamB, "a"],
      [m.teamB, m.teamA, "b"],
    ]) {
      const row = rows.get(String(id));
      row.wins += Number(String(m.winner) === String(id));
      row.losses += Number(String(m.winner) === String(other));
      row.points += m.scores.reduce((s, g) => s + g[side], 0);
      row.conceded += m.scores.reduce(
        (s, g) => s + g[side === "a" ? "b" : "a"],
        0,
      );
    }
  }
  return [...rows.values()].sort(
    (a, b) =>
      b.wins - a.wins ||
      b.points - b.conceded - (a.points - a.conceded) ||
      b.points - a.points ||
      a.team.localeCompare(b.team),
  );
}
export async function advanceBracket(event, session) {
  let matches = await Match.find({ eventId: event._id }).session(session);
  const byKey = new Map(matches.map((m) => [m.bracketKey, m]));
  const resolve = (source) => {
    if (source === "BYE") return { known: true, id: null };
    const [kind, key] = source.split(":");
    if (kind === "T") return { known: true, id: key };
    const m = byKey.get(key);
    if (!m || !["finalized", "bye"].includes(m.matchStatus))
      return { known: false };
    return {
      known: true,
      id:
        kind === "W"
          ? m.winner
          : m.matchStatus === "bye"
            ? null
            : String(m.teamA) === String(m.winner)
              ? m.teamB
              : m.teamA,
    };
  };
  const dependencyTime = (sources) =>
    Math.max(
      +event.startDateTime,
      ...sources.map((source) => {
        const [kind, key] = source.split(":");
        const parent = ["W", "L"].includes(kind) ? byKey.get(key) : null;
        return parent?.startDateTime
          ? +parent.startDateTime + event.matchDuration * 60_000
          : +event.startDateTime;
      }),
    );
  for (let pass = 0; pass < matches.length; pass++) {
    let changed = false;
    for (const m of matches.filter((m) => m.matchStatus === "pending")) {
      const sources = m.sources.map(resolve);
      if (!sources.every((s) => s.known)) continue;
      [m.teamA, m.teamB] = sources.map((s) => s.id);
      if (!m.teamA || !m.teamB) {
        m.matchStatus = "bye";
        m.winner = m.teamA || m.teamB;
      } else {
        m.matchStatus = "scheduled";
        const groupEnd = m.bracketKey.startsWith("K")
          ? Math.max(
              +event.startDateTime,
              ...matches
                .filter(
                  (other) =>
                    other.stage?.startsWith("group-") && other.startDateTime,
                )
                .map(
                  (other) =>
                    +other.startDateTime + event.matchDuration * 60_000,
                ),
            )
          : +event.startDateTime;
        Object.assign(
          m,
          reserveCourt(
            event,
            matches.filter((other) => other !== m),
            m.teamA,
            m.teamB,
            Math.max(groupEnd, dependencyTime(m.sources)),
          ),
        );
      }
      await m.save({ session });
      changed = true;
    }
    if (!changed) break;
  }
  const tournament = await Tournament.findOne({ eventId: event._id }).session(
    session,
  );
  if (!tournament) return;
  tournament.standings = standings(matches);
  const groups = matches.filter((m) => m.stage?.startsWith("group-"));
  if (
    event.format === "group-knockout" &&
    groups.length &&
    groups.every((m) => ["finalized", "bye"].includes(m.matchStatus)) &&
    !matches.some((m) => m.bracketKey.startsWith("K"))
  ) {
    const qualifiers = [...new Set(groups.map((m) => m.stage))].flatMap(
      (stage) =>
        standings(groups.filter((m) => m.stage === stage))
          .slice(0, 2)
          .map((r) => ({ _id: r.team })),
    );
    await Match.insertMany(
      eliminationNodes(qualifiers, false, "K").map((n) => ({
        ...n,
        eventId: event._id,
        matchStatus: "pending",
        rated: event.rated,
      })),
      { session },
    );
    await tournament.save({ session });
    return advanceBracket(event, session);
  }
  if (event.format === "double-elimination") {
    const gf = byKey.get("GF");
    if (gf?.matchStatus === "finalized") {
      if (String(gf.winner) === String(gf.teamB) && event.grandFinalReset) {
        let reset = byKey.get("RESET");
        if (!reset) {
          [reset] = await Match.create(
            [
              {
                eventId: event._id,
                bracketKey: "RESET",
                rated: event.rated,
                sources: [`T:${gf.teamA}`, `T:${gf.teamB}`],
                stage: "reset",
                roundNumber: gf.roundNumber + 1,
                teamA: gf.teamA,
                teamB: gf.teamB,
                ...reserveCourt(
                  event,
                  matches,
                  gf.teamA,
                  gf.teamB,
                  +gf.startDateTime + event.matchDuration * 60_000,
                ),
                matchStatus: "scheduled",
              },
            ],
            { session },
          );
        }
        tournament.champion =
          reset.matchStatus === "finalized" ? reset.winner : undefined;
      } else tournament.champion = gf.winner;
    }
  } else if (event.format === "round-robin") {
    if (matches.every((m) => ["finalized", "bye"].includes(m.matchStatus)))
      tournament.champion = tournament.standings[0]?.team;
  } else {
    const final = matches
      .filter((m) => m.stage === "winners")
      .sort((a, b) => b.roundNumber - a.roundNumber)[0];
    if (final && ["finalized", "bye"].includes(final.matchStatus))
      tournament.champion = final.winner;
  }
  await tournament.save({ session });
}
export async function invalidateDescendants(match, session, cascade = false) {
  const all = await Match.find({ eventId: match.eventId }).session(session);
  const affected = new Set([match.bracketKey]);
  // Group standings can change every knockout seed. Rebuild knockout after correction.
  if (match.stage?.startsWith("group-")) {
    const knockout = all.filter((m) => m.bracketKey?.startsWith("K"));
    ensure(
      cascade || !knockout.some((m) => m.matchStatus === "finalized"),
      "This correction invalidates knockout results. Confirm cascade correction.",
    );
    await Match.deleteMany(
      { _id: { $in: knockout.map((m) => m._id) } },
      { session },
    );
  }
  for (let i = 0; i < all.length; i++)
    for (const m of all)
      if (m.sources.some((s) => affected.has(s.slice(2))))
        affected.add(m.bracketKey);
  if (affected.has("GF")) affected.add("RESET");
  const descendants = all.filter(
    (m) =>
      m._id.toString() !== match._id.toString() && affected.has(m.bracketKey),
  );
  ensure(
    cascade || !descendants.some((m) => m.matchStatus === "finalized"),
    "This correction invalidates downstream results. Confirm cascade correction.",
  );
  if (affected.has("RESET") && match.bracketKey !== "RESET")
    await Match.deleteOne(
      { eventId: match.eventId, bracketKey: "RESET" },
      { session },
    );
  for (const m of descendants.filter((m) => m.bracketKey !== "RESET")) {
    m.teamA = undefined;
    m.teamB = undefined;
    m.winner = undefined;
    m.startDateTime = undefined;
    m.completedAt = undefined;
    m.scores = [];
    m.revision++;
    m.matchStatus = "pending";
    await m.save({ session });
  }
  await Tournament.updateOne(
    { eventId: match.eventId },
    { $unset: { champion: 1 } },
    { session },
  );
}
