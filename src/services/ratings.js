import crypto from "node:crypto";
import {
  User,
  Match,
  Settings,
  PlayerRating,
  RatingHistory,
  RatingOverride,
  RANKINGS,
} from "../models/index.js";
import {
  DEFAULT_RATING_POLICY,
  seedRating,
  replayRatings,
} from "../domain/ratings.js";
import { notify } from "./notifications.js";

export function policySnapshot(settings) {
  const value = settings?.rating?.toObject?.() || settings?.rating || {};
  return {
    ...DEFAULT_RATING_POLICY,
    ...value,
    promotionThresholds: [
      ...(value.promotionThresholds ||
        DEFAULT_RATING_POLICY.promotionThresholds),
    ],
    demotionThresholds: [
      ...(value.demotionThresholds || DEFAULT_RATING_POLICY.demotionThresholds),
    ],
  };
}

// One shared document serializes every rating-affecting transaction across events.
// Never execute parallel operations inside a MongoDB transaction.
export async function lockRatings(session) {
  return Settings.findOneAndUpdate(
    { key: "global" },
    { $inc: { ratingRevision: 1 } },
    { upsert: true, returnDocument: "after", session },
  );
}
export function captureRatingPolicy(match, settings) {
  if (!match.rated) match.ratingPolicy = undefined;
  else if (!match.ratingPolicy && policySnapshot(settings).enabled)
    match.ratingPolicy = policySnapshot(settings);
}
export async function ensureRatingProfiles(session) {
  const users = await User.find()
    .select(
      "provisionalRanking officialRanking rankingStatus doublesRating automaticRanking",
    )
    .session(session)
    .lean();
  if (users.length)
    await PlayerRating.bulkWrite(
      users.map((user) => {
        const rank = user.officialRanking || user.provisionalRanking;
        return {
          updateOne: {
            filter: { playerId: user._id, pool: "doubles" },
            update: {
              $setOnInsert: {
                playerId: user._id,
                pool: "doubles",
                baselineRating: seedRating(rank),
                baselineRank: rank,
                ...(user.officialRanking
                  ? { baselineOfficialRanking: user.officialRanking }
                  : {}),
                baselineRankingStatus: user.rankingStatus || "provisional",
                rating: seedRating(rank),
                rank,
                ratedMatches: 0,
                automaticConfirmed: false,
                manualLocked: false,
              },
            },
            upsert: true,
          },
        };
      }),
      { session },
    );
}

export async function rebuildRatings(session, { notifications = true } = {}) {
  await ensureRatingProfiles(session);
  const baselines = await PlayerRating.find({ pool: "doubles" })
    .session(session)
    .lean();
  const previous = new Map(baselines.map((p) => [String(p.playerId), p]));
  const matches = await Match.find({
    matchStatus: "finalized",
    rated: true,
    "ratingPolicy.kFactor": { $exists: true },
  })
    .populate("teamA teamB")
    .sort({ completedAt: 1, _id: 1 })
    .session(session)
    .lean();
  const overrides = await RatingOverride.find({ pool: "doubles" })
    .session(session)
    .lean();
  const timeline = matches.map((m) => {
    if (
      !m.completedAt ||
      !m.teamA ||
      !m.teamB ||
      ![String(m.teamA._id), String(m.teamB._id)].includes(String(m.winner))
    )
      throw new Error(`Invalid rated match ${m._id}`);
    return {
      kind: "match",
      id: m._id,
      teamA: m.teamA.players,
      teamB: m.teamB.players,
      wonA: String(m.winner) === String(m.teamA._id),
      timestamp: m.completedAt,
      policy: m.ratingPolicy,
    };
  });
  timeline.push(
    ...overrides.map((o) => ({ ...o, id: o._id, kind: "override" })),
  );
  const { states, history } = replayRatings(baselines, timeline);
  const now = new Date();
  const rows = history.map((row) => ({
    ...row,
    _id: crypto
      .createHash("sha256")
      .update(
        `${row.pool}:${row.playerId}:${row.kind}:${row.matchId || row.overrideId}`,
      )
      .digest("hex")
      .slice(0, 24),
  }));
  // Stable IDs and unique ledger indexes keep replay and resubmission idempotent.
  await RatingHistory.deleteMany(
    { pool: "doubles", _id: { $nin: rows.map((row) => row._id) } },
    { session },
  );
  if (rows.length)
    await RatingHistory.bulkWrite(
      rows.map((row) => ({
        updateOne: {
          filter: { _id: row._id },
          update: { $set: row },
          upsert: true,
        },
      })),
      { session },
    );
  if (states.length) {
    await PlayerRating.bulkWrite(
      states.map((state) => ({
        updateOne: {
          filter: { playerId: state.playerId, pool: "doubles" },
          update: {
            $set: {
              rating: state.rating,
              rank: state.rank,
              ratedMatches: state.matches,
              automaticConfirmed: state.automaticConfirmed,
              manualLocked: state.manualLocked,
            },
          },
        },
      })),
      { session },
    );
    await User.bulkWrite(
      states.map((state) => ({
        updateOne: {
          filter: { _id: state.playerId },
          update: {
            $set: {
              doublesRating: state.rating,
              doublesRatedMatches: state.matches,
              automaticRanking: state.rank,
              automaticRankingStatus: state.automaticConfirmed
                ? "confirmed"
                : "provisional",
              rankingOverride: state.manualLocked,
              rankingStatus: state.rankingStatus,
              ...(state.officialRanking
                ? { officialRanking: state.officialRanking }
                : {}),
            },
            ...(!state.officialRanking
              ? { $unset: { officialRanking: 1 } }
              : {}),
          },
        },
      })),
      { session },
    );
  }
  if (notifications)
    for (const state of states) {
      const before = previous.get(state.playerId);
      if (!before || state.manualLocked) continue;
      if (state.rank !== before.rank) {
        await notify(
          [state.playerId],
          state.rank > before.rank ? "Player promoted" : "Player demoted",
          `Your doubles skill category is now ${RANKINGS[state.rank - 1]} (${state.rating.toFixed(1)} Elo).`,
          "ranking",
          session,
        );
      } else if (state.automaticConfirmed && !before.automaticConfirmed) {
        await notify(
          [state.playerId],
          "Automatic skill rank confirmed",
          `You have completed ${state.matches} rated doubles matches. Your automatic rank is level ${state.rank}.`,
          "ranking",
          session,
        );
      }
    }
  return {
    pool: "doubles",
    players: states.length,
    ratedMatches: matches.length,
    historyEntries: rows.length,
    recalculatedAt: now,
  };
}
