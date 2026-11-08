import { Match, EventRegistration, Tournament } from "../models/index.js";
export async function playerStats(id, filter = {}) {
  const all = await Match.find({
    matchStatus: "finalized",
    ...(filter.since ? { completedAt: { $gte: filter.since } } : {}),
  })
    .populate("teamA teamB")
    .populate("eventId", "eventName eventType")
    .sort({ completedAt: 1 })
    .lean();
  const matches = all.filter(
    (m) =>
      m.eventId &&
      (!filter.type || m.eventId.eventType === filter.type) &&
      [...(m.teamA?.players || []), ...(m.teamB?.players || [])].some(
        (p) => String(p) === String(id),
      ),
  );
  let wins = 0,
    pointsScored = 0,
    pointsConceded = 0,
    streak = 0,
    longestStreak = 0;
  const monthly = {},
    teammates = {};
  const history = matches.map((m) => {
    const onA = m.teamA.players.some((p) => String(p) === String(id));
    const team = onA ? m.teamA : m.teamB;
    const won = String(m.winner) === String(team._id);
    if (won) {
      wins++;
      streak++;
      longestStreak = Math.max(streak, longestStreak);
    } else streak = 0;
    for (const s of m.scores) {
      pointsScored += onA ? s.a : s.b;
      pointsConceded += onA ? s.b : s.a;
    }
    const month = m.completedAt.toISOString().slice(0, 7);
    monthly[month] ||= { matches: 0, wins: 0 };
    monthly[month].matches++;
    monthly[month].wins += Number(won);
    const mate = String(team.players.find((p) => String(p) !== String(id)));
    teammates[mate] ||= { matches: 0, wins: 0 };
    teammates[mate].matches++;
    teammates[mate].wins += Number(won);
    return {
      ...m,
      result: won ? "Win" : "Loss",
      teammate: mate,
      opponents: (onA ? m.teamB : m.teamA).players,
      cumulativeWinRate:
        (wins / Object.values(monthly).reduce((s, v) => s + v.matches, 0)) *
        100,
    };
  });
  const registrations = await EventRegistration.find({
    userId: id,
    registrationStatus: "confirmed",
  })
    .populate("eventId", "eventType")
    .lean();
  const championships = await Tournament.find({ champion: { $ne: null } })
    .populate("champion")
    .lean();
  const championshipCount = championships.filter((t) => {
    if (filter.type && filter.type !== "tournament") return false;
    if (!t.champion?.players.some((p) => String(p) === String(id)))
      return false;
    const finalResults = all.filter(
      (m) => String(m.eventId?._id) === String(t.eventId),
    );
    return !filter.since || finalResults.length > 0;
  }).length;
  const tournamentWins = history.filter(
    (m) => m.eventId.eventType === "tournament" && m.result === "Win",
  ).length;
  return {
    matches: matches.length,
    wins,
    losses: matches.length - wins,
    winRate: matches.length ? (wins / matches.length) * 100 : 0,
    pointsScored,
    pointsConceded,
    pointDifferential: pointsScored - pointsConceded,
    streak,
    longestStreak,
    tournaments: registrations.filter(
      (r) => r.eventId?.eventType === "tournament",
    ).length,
    openPlay: registrations.filter((r) => r.eventId?.eventType === "open-play")
      .length,
    championships: championshipCount,
    tournamentPoints: tournamentWins * 3 + championshipCount * 10,
    monthly,
    teammates,
    history,
  };
}
