// Club-defined doubles Elo policy, not an official DUPR or federation rating.
export const DEFAULT_RATING_POLICY = Object.freeze({
  enabled: false,
  kFactor: 32,
  minimumRatedMatches: 10,
  hysteresis: 20,
  promotionThresholds: Array.from({ length: 11 }, (_, i) => (i + 1) * 200),
  demotionThresholds: Array.from({ length: 11 }, (_, i) => (i + 1) * 200),
});

export function seedRating(rank) {
  return 100 + (rank - 1) * 200;
}
export function numericalRating(player) {
  return (
    player.$locals?.rankingMMR ??
    player.doublesRating ??
    seedRating(player.officialRanking || player.provisionalRanking)
  );
}
export function expectedOutcome(teamA, teamB) {
  const average = (team) =>
    team.reduce((sum, value) => sum + value, 0) / team.length;
  return 1 / (1 + 10 ** ((average(teamB) - average(teamA)) / 400));
}
export function doublesAdjustment(teamA, teamB, wonA, kFactor = 32) {
  if (
    teamA.length !== 2 ||
    teamB.length !== 2 ||
    ![...teamA, ...teamB, kFactor].every(Number.isFinite) ||
    kFactor <= 0
  )
    throw new Error(
      "Doubles Elo requires two finite ratings per team and a positive K-factor",
    );
  const expectedA = expectedOutcome(teamA, teamB);
  const adjustmentA = kFactor * (Number(wonA) - expectedA);
  // Equal adjustments for both partners; no score-margin multiplier or rating floor.
  return { expectedA, adjustmentA, adjustmentB: -adjustmentA };
}
export function categoryWithHysteresis(
  rating,
  currentRank,
  policy = DEFAULT_RATING_POLICY,
) {
  let rank = currentRank;
  if (
    rank < 12 &&
    rating >= policy.promotionThresholds[rank - 1] + policy.hysteresis
  ) {
    while (
      rank < 12 &&
      rating >= policy.promotionThresholds[rank - 1] + policy.hysteresis
    )
      rank++;
  } else {
    while (
      rank > 1 &&
      rating < policy.demotionThresholds[rank - 2] - policy.hysteresis
    )
      rank--;
  }
  return rank;
}

// Pure replay makes corrections affect every later opponent/partner consistently.
export function replayRatings(baselines, timeline) {
  const states = new Map(
    baselines.map((base) => [
      String(base.playerId),
      {
        playerId: String(base.playerId),
        rating: base.baselineRating,
        rank: base.baselineRank,
        officialRanking: base.baselineOfficialRanking,
        rankingStatus: base.baselineRankingStatus,
        matches: 0,
        manualLocked: false,
        automaticConfirmed: false,
      },
    ]),
  );
  const history = [];
  const ordered = [...timeline].sort(
    (a, b) =>
      +new Date(a.timestamp) - +new Date(b.timestamp) ||
      String(a.id).localeCompare(String(b.id)),
  );
  const applyRank = (state, policy) => {
    state.automaticConfirmed = state.matches >= policy.minimumRatedMatches;
    if (!state.manualLocked && state.automaticConfirmed) {
      state.rank = categoryWithHysteresis(state.rating, state.rank, policy);
      state.officialRanking = state.rank;
      state.rankingStatus = "confirmed";
    }
  };
  for (const entry of ordered) {
    if (entry.kind === "override") {
      const state = states.get(String(entry.playerId));
      if (!state)
        throw new Error("Override references a missing rating profile");
      const previousRating = state.rating,
        previousRank = state.rank;
      if (entry.action === "manual") {
        state.rating = entry.rating;
        state.rank = entry.rank;
        state.officialRanking = entry.rank;
        state.rankingStatus = "confirmed";
        state.manualLocked = true;
      } else {
        state.manualLocked = false;
        applyRank(state, entry.policy);
      }
      history.push({
        playerId: state.playerId,
        pool: "doubles",
        kind: "override",
        overrideId: entry.id,
        previousRating,
        newRating: state.rating,
        adjustment: state.rating - previousRating,
        previousRank,
        newRank: state.rank,
        ratedMatches: state.matches,
        timestamp: entry.timestamp,
        reason: entry.reason,
      });
      continue;
    }
    const ids = [...entry.teamA, ...entry.teamB].map(String);
    if (
      ids.length !== 4 ||
      new Set(ids).size !== 4 ||
      ids.some((id) => !states.has(id))
    )
      throw new Error(
        "Rated match must contain four distinct players with rating profiles",
      );
    const a = entry.teamA.map((id) => states.get(String(id))),
      b = entry.teamB.map((id) => states.get(String(id)));
    const { expectedA, adjustmentA, adjustmentB } = doublesAdjustment(
      a.map((p) => p.rating),
      b.map((p) => p.rating),
      entry.wonA,
      entry.policy.kFactor,
    );
    for (const [players, delta, expected, actual] of [
      [a, adjustmentA, expectedA, Number(entry.wonA)],
      [b, adjustmentB, 1 - expectedA, 1 - Number(entry.wonA)],
    ]) {
      for (const state of players) {
        const previousRating = state.rating,
          previousRank = state.rank;
        state.rating += delta;
        state.matches++;
        applyRank(state, entry.policy);
        history.push({
          playerId: state.playerId,
          pool: "doubles",
          kind: "match",
          matchId: entry.id,
          previousRating,
          newRating: state.rating,
          adjustment: delta,
          expectedScore: expected,
          actualScore: actual,
          previousRank,
          newRank: state.rank,
          ratedMatches: state.matches,
          kFactor: entry.policy.kFactor,
          timestamp: entry.timestamp,
        });
      }
    }
  }
  return {
    states: [...states.values()],
    history: history.map((row, sequence) => ({ ...row, sequence })),
  };
}
