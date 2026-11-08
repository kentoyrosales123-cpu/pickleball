import crypto from "node:crypto";
import { User, Match, AuditLog } from "../models/index.js";
import {
  PlayerRanking,
  RankingHistory,
  RankingSeason,
  SeasonRanking,
  RankingAdjustment,
} from "../models/ranking.js";
import { initialRanking, replayRanking, RULES } from "../domain/ranking.js";
import { notify } from "./notifications.js";
export async function ensureRankings(session) {
  const users = await User.find()
    .select("_id createdAt")
    .session(session)
    .lean();
  if (users.length)
    await PlayerRanking.bulkWrite(
      users.map((u) => ({
        updateOne: {
          filter: { userId: u._id },
          update: {
            $setOnInsert: {
              userId: u._id,
              state: initialRanking(),
              version: 0,
            },
          },
          upsert: true,
        },
      })),
      { session },
    );
  return users;
}
export async function captureStarPolicy(match, session) {
  if (!match.rated) return;
  if (!match.starPolicy) {
    const season = await RankingSeason.findOne({ status: "active" }).session(
      session,
    );
    const now = match.completedAt || new Date();
    if (season && now >= season.startDate && now <= season.endDate) {
      match.starPolicy = { ...season.rankingRules };
      match.rankingSeasonId = season._id;
    } else match.starPolicy = { ...RULES };
  }
}
export async function rebuildStarRankings(session, { actorId } = {}) {
  const users = await ensureRankings(session);
  const matches = await Match.find({
    rated: true,
    matchStatus: "finalized",
    starPolicy: { $ne: null },
  })
    .populate("teamA teamB")
    .session(session)
    .lean();
  const seasons = await RankingSeason.find().session(session).lean();
  const adjustments = await RankingAdjustment.find().session(session).lean();
  const old = await RankingHistory.find().session(session).lean();
  const entries = matches.map((m) => {
    if (
      !m.teamA ||
      !m.teamB ||
      ![String(m.teamA._id), String(m.teamB._id)].includes(String(m.winner))
    )
      throw new Error("Invalid ranked teams or winner");
    return {
      id: m._id,
      eventId: m.eventId,
      kind: "match",
      teamA: m.teamA.players,
      teamB: m.teamB.players,
      wonA: String(m.winner) === String(m.teamA._id),
      timestamp: m.completedAt,
      rules: m.starPolicy,
    };
  });
  entries.push(
    ...seasons
      .filter((s) => s.endDate <= new Date())
      .map((s) => ({ id: s._id, kind: "close", timestamp: s.endDate })),
    ...seasons.map((s) => ({
      ...s,
      id: s._id,
      kind: "season",
      timestamp: s.startDate,
    })),
    ...adjustments.map((a) => ({ ...a, id: a._id, kind: "adjustment" })),
  );
  const { states, history, snapshots } = replayRanking(
    users.map((u) => u._id),
    entries,
  );
  // Match-season association is immutable even after the season has ended.
  const seasonByMatch = new Map(
    matches.map((m) => [String(m._id), m.rankingSeasonId || null]),
  );
  for (const row of history)
    if (row.kind === "match") row.seasonId = seasonByMatch.get(row.sourceId);
  const oldByKey = new Map(old.map((h) => [`${h.playerId}:${h.sourceId}`, h]));
  for (const row of history) {
    const previous = oldByKey.get(`${row.playerId}:${row.sourceId}`);
    if (
      !previous ||
      JSON.stringify(previous.after) !== JSON.stringify(row.after)
    ) {
      if (previous)
        await AuditLog.create(
          [
            {
              actorId: actorId || row.playerId,
              action: "ranking-replay",
              entityType: "RankingHistory",
              entityId: String(previous._id),
              previousValue: previous,
              newValue: row,
            },
          ],
          { session },
        );
      if (row.kind === "match")
        await notify(
          [row.playerId],
          previous
            ? "Ranking corrected"
            : row.protectionActivated
              ? "STAR PROTECTED"
              : row.doubleStarActivated
                ? "DOUBLE STAR BONUS"
                : "Ranked match verified",
          `${row.starsChanged >= 0 ? "+" : ""}${row.starsChanged} stars · ${row.after.rankTier} ${row.after.rankDivision || ""}${row.rankPromoted ? " · Promoted!" : row.rankDemoted ? " · Demoted" : ""}`,
          "star-ranking",
          session,
        );
    }
  }
  const rows = history.map((row) => ({
    ...row,
    _id: crypto
      .createHash("sha256")
      .update(`${row.playerId}:${row.sourceId}`)
      .digest("hex")
      .slice(0, 24),
  }));
  for (const previous of old)
    if (
      !history.some(
        (h) =>
          String(h.playerId) === String(previous.playerId) &&
          h.sourceId === previous.sourceId,
      )
    )
      await AuditLog.create(
        [
          {
            actorId: actorId || previous.playerId,
            action: "ranking-reversed",
            entityType: "RankingHistory",
            entityId: String(previous._id),
            previousValue: previous,
            newValue: null,
          },
        ],
        { session },
      );
  await RankingHistory.deleteMany(
    { _id: { $nin: rows.map((r) => r._id) } },
    { session },
  );
  if (rows.length)
    await RankingHistory.bulkWrite(
      rows.map((row) => ({
        replaceOne: {
          filter: { _id: row._id },
          replacement: row,
          upsert: true,
        },
      })),
      { session },
    );
  if (states.size)
    await PlayerRanking.bulkWrite(
      [...states].map(([userId, state]) => ({
        updateOne: {
          filter: { userId },
          update: { $set: { state }, $inc: { version: 1 } },
        },
      })),
      { session },
    );
  const joined = new Map(users.map((u) => [String(u._id), u.createdAt]));
  const seasonEnds = new Map(seasons.map((s) => [String(s._id), s.endDate]));
  const eligibleSnapshots = snapshots.filter(
    (row) => joined.get(row.playerId) <= seasonEnds.get(row.seasonId),
  );
  if (eligibleSnapshots.length)
    await SeasonRanking.bulkWrite(
      eligibleSnapshots.map((row) => ({
        updateOne: {
          filter: { playerId: row.playerId, seasonId: row.seasonId },
          update: { $set: row },
          upsert: true,
        },
      })),
      { session },
    );
  await Match.updateMany(
    { rankingApplied: true, _id: { $nin: matches.map((m) => m._id) } },
    { $set: { rankingApplied: false } },
    { session },
  );
  if (matches.length)
    await Match.updateMany(
      { _id: { $in: matches.map((m) => m._id) } },
      { $set: { rankingApplied: true, rankingVersion: 1 } },
      { session },
    );
}
