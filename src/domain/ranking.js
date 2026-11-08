export const TIERS = [
  "Rookie",
  "Bronze",
  "Silver",
  "Gold",
  "Platinum",
  "Diamond",
  "Ace",
  "Master",
  "Grandmaster",
  "Legend",
];
export const RULES = Object.freeze({
  normalPoints: 20,
  strongerPoints: 30,
  strongerGap: 150,
  placementK: 40,
  regularK: 24,
  placementMatches: 10,
});
export function rankFor(stars) {
  if (!Number.isSafeInteger(stars) || stars < 0)
    throw new Error("Invalid cumulative stars");
  const step = Math.floor(stars / 5);
  return {
    rankTier: TIERS[Math.min(9, Math.floor(step / 3))],
    rankDivision: step >= 27 ? null : ["III", "II", "I"][step % 3],
    stars: step >= 27 ? stars - 135 : stars % 5,
    progress: step >= 27 ? null : (stars % 5) / 5,
    nextRank:
      step >= 27
        ? null
        : `${TIERS[Math.floor((step + 1) / 3)]} ${step + 1 >= 27 ? "" : ["III", "II", "I"][(step + 1) % 3]}`.trim(),
  };
}
export function initialRanking() {
  return {
    rankStars: 0,
    lifetimeStars: 0,
    mmr: 1000,
    protectionPoints: 0,
    doubleStarPoints: 0,
    totalWins: 0,
    totalLosses: 0,
    rankedMatches: 0,
    placementCount: 0,
    currentWinStreak: 0,
    longestWinStreak: 0,
    highestRank: 0,
    seasonHighestRank: 0,
    seasonId: null,
    ...rankFor(0),
  };
}
export function applyOutcome(
  before,
  won,
  ownAverage,
  opponentAverage,
  rules = RULES,
) {
  const state = { ...before };
  const expected = 1 / (1 + 10 ** ((opponentAverage - ownAverage) / 400));
  const k =
    state.placementCount < rules.placementMatches
      ? rules.placementK
      : rules.regularK;
  const points =
    opponentAverage - ownAverage >= rules.strongerGap
      ? rules.strongerPoints
      : rules.normalPoints;
  let protectionActivated = false,
    doubleStarActivated = false,
    delta = won ? 1 : -1;
  if (won) {
    state.doubleStarPoints += points;
    if (state.doubleStarPoints >= 100) {
      state.doubleStarPoints -= 100;
      delta++;
      doubleStarActivated = true;
    }
    state.totalWins++;
    state.currentWinStreak++;
    state.longestWinStreak = Math.max(
      state.longestWinStreak,
      state.currentWinStreak,
    );
  } else {
    state.protectionPoints += points;
    if (state.protectionPoints >= 100) {
      state.protectionPoints -= 100;
      delta = 0;
      protectionActivated = true;
    }
    state.totalLosses++;
    state.currentWinStreak = 0;
  }
  state.rankStars = Math.max(0, state.rankStars + delta);
  state.lifetimeStars = Math.max(0, state.lifetimeStars + delta);
  state.mmr += k * (Number(won) - expected);
  state.rankedMatches++;
  state.placementCount++;
  state.highestRank = Math.max(state.highestRank, state.rankStars);
  state.seasonHighestRank = Math.max(state.seasonHighestRank, state.rankStars);
  Object.assign(state, rankFor(state.rankStars));
  return {
    state,
    protectionActivated,
    doubleStarActivated,
    kFactor: k,
    expectedScore: expected,
    starsChanged: state.rankStars - before.rankStars,
    mmrChanged: state.mmr - before.mmr,
    rankPromoted:
      Math.floor(state.rankStars / 5) > Math.floor(before.rankStars / 5) &&
      before.rankStars < 135,
    rankDemoted:
      Math.floor(state.rankStars / 5) < Math.floor(before.rankStars / 5) &&
      state.rankStars < 135,
  };
}
// Full chronological replay propagates corrections through later partners and opponents.
export function replayRanking(playerIds, entries) {
  const states = new Map(playerIds.map((id) => [String(id), initialRanking()])),
    history = [],
    snapshots = [];
  const ordered = [...entries].sort(
    (a, b) =>
      +new Date(a.timestamp) - +new Date(b.timestamp) ||
      ({ close: 0, season: 1 }[a.kind] ?? 2) -
        ({ close: 0, season: 1 }[b.kind] ?? 2) ||
      String(a.id).localeCompare(String(b.id)),
  );
  for (const entry of ordered) {
    if (entry.kind === "close") {
      for (const [playerId, state] of states)
        if (state.seasonId === String(entry.id)) {
          snapshots.push({
            playerId,
            seasonId: state.seasonId,
            state: { ...state },
          });
          state.seasonId = null;
        }
      continue;
    }
    if (entry.kind === "season") {
      for (const [playerId, state] of states) {
        if (state.seasonId)
          snapshots.push({
            playerId,
            seasonId: state.seasonId,
            state: { ...state },
          });
        if (entry.resetPolicy === "partial")
          state.rankStars = Math.floor(state.rankStars * entry.keepFraction);
        if (entry.resetPolicy === "placement") {
          state.rankStars = 0;
          state.mmr = (state.mmr + 1000) / 2;
          state.placementCount = 0;
        }
        state.seasonId = String(entry.id);
        state.seasonHighestRank = state.rankStars;
        state.protectionPoints = 0;
        state.doubleStarPoints = 0;
        Object.assign(state, rankFor(state.rankStars));
      }
      continue;
    }
    if (entry.kind === "adjustment") {
      const state = states.get(String(entry.playerId));
      if (!state) throw new Error("Missing adjusted player");
      const before = { ...state };
      state.rankStars = entry.rankStars;
      state.highestRank = Math.max(state.highestRank, entry.rankStars);
      state.seasonHighestRank = Math.max(
        state.seasonHighestRank,
        entry.rankStars,
      );
      Object.assign(state, rankFor(state.rankStars));
      history.push({
        playerId: String(entry.playerId),
        sourceId: String(entry.id),
        kind: "adjustment",
        seasonId: state.seasonId,
        timestamp: entry.timestamp,
        reason: entry.reason,
        before,
        after: { ...state },
        starsChanged: state.rankStars - before.rankStars,
      });
      continue;
    }
    const ids = [...entry.teamA, ...entry.teamB].map(String);
    if (
      ids.length !== 4 ||
      new Set(ids).size !== 4 ||
      ids.some((id) => !states.has(id))
    )
      throw new Error("Ranked doubles requires four distinct existing players");
    const avg = (team) =>
      team.reduce((sum, id) => sum + states.get(String(id)).mmr, 0) / 2;
    const a = avg(entry.teamA),
      b = avg(entry.teamB);
    for (const [team, won, own, opposing] of [
      [entry.teamA, entry.wonA, a, b],
      [entry.teamB, !entry.wonA, b, a],
    ])
      for (const id of team) {
        const before = { ...states.get(String(id)) },
          outcome = applyOutcome(before, won, own, opposing, entry.rules);
        states.set(String(id), outcome.state);
        const { state, ...effects } = outcome;
        history.push({
          playerId: String(id),
          sourceId: String(entry.id),
          matchId: entry.id,
          eventId: entry.eventId,
          kind: "match",
          seasonId: state.seasonId,
          timestamp: entry.timestamp,
          before,
          after: { ...state },
          won,
          ...effects,
        });
      }
  }
  for (const [playerId, state] of states)
    if (state.seasonId)
      snapshots.push({
        playerId,
        seasonId: state.seasonId,
        state: { ...state },
      });
  return { states, history, snapshots };
}
export function balancedFour(players, previous = []) {
  if (
    players.length !== 4 ||
    new Set(players.map((p) => String(p._id))).size !== 4
  )
    throw new Error("Four distinct players required");
  const key = (pair) =>
    pair
      .map((p) => String(p._id))
      .sort()
      .join(":");
  const old = new Set(
    previous.map((pair) => pair.map(String).sort().join(":")),
  );
  const candidates = [
    [0, 1, 2, 3],
    [0, 2, 1, 3],
    [0, 3, 1, 2],
  ].map((indices) => {
    const a = indices.slice(0, 2).map((i) => players[i]),
      b = indices.slice(2).map((i) => players[i]);
    const gap = Math.abs((a[0].mmr + a[1].mmr - b[0].mmr - b[1].mmr) / 2);
    return {
      teamA: a.map((p) => p._id),
      teamB: b.map((p) => p._id),
      gap,
      cost:
        gap +
        (Math.abs(a[0].mmr - a[1].mmr) + Math.abs(b[0].mmr - b[1].mmr)) * 0.02 +
        Number(old.has(key(a))) * 10 +
        Number(old.has(key(b))) * 10,
    };
  });
  return candidates.sort((a, b) => a.cost - b.cost)[0];
}
