import mongoose from "mongoose";
import {
  RankingSeason,
  SeasonRanking,
  RankingHistory,
} from "../models/ranking.js";
import { rankFor } from "../domain/ranking.js";
import { rebuildStarRankings } from "./ranking.js";
import { lockRatings } from "./ratings.js";
import { publish } from "./notifications.js";

export async function closeExpiredSeasons(now = new Date()) {
  if (
    !(await RankingSeason.exists({ status: "active", endDate: { $lte: now } }))
  )
    return 0;
  const count = await mongoose.connection.transaction(async (session) => {
    await lockRatings(session);
    const result = await RankingSeason.updateMany(
      { status: "active", endDate: { $lte: now } },
      { $set: { status: "closed" } },
      { session },
    );
    if (result.modifiedCount) await rebuildStarRankings(session);
    return result.modifiedCount;
  });
  if (count) publish();
  return count;
}

export async function seasonResults(id) {
  const season = await RankingSeason.findById(id).lean();
  if (!season) return null;
  const snapshots = await SeasonRanking.find({ seasonId: id })
    .populate("playerId", "fullName profileImage")
    .lean();
  const records = await RankingHistory.find({ seasonId: id, kind: "match" })
    .select("playerId won")
    .lean();
  const stats = new Map();
  for (const record of records) {
    const key = String(record.playerId),
      value = stats.get(key) || { wins: 0, losses: 0 };
    value[record.won ? "wins" : "losses"]++;
    stats.set(key, value);
  }
  const archived = season.status === "closed";
  const rows = snapshots
    .filter((row) => row.playerId && stats.has(String(row.playerId._id)))
    .sort(
      (a, b) =>
        b.state.rankStars - a.state.rankStars ||
        b.state.mmr - a.state.mmr ||
        stats.get(String(b.playerId._id)).wins -
          stats.get(String(a.playerId._id)).wins ||
        String(a.playerId._id).localeCompare(String(b.playerId._id)),
    )
    .map((row, index) => {
      const playerId = String(row.playerId._id),
        record = stats.get(playerId);
      const finalRank = rankFor(row.state.rankStars);
      return {
        playerId,
        fullName: row.playerId.fullName,
        profileImage: row.playerId.profileImage,
        position: index + 1,
        finalStars: row.state.rankStars,
        finalRank,
        highestStars: row.state.seasonHighestRank,
        highestRank: rankFor(row.state.seasonHighestRank),
        ...record,
        matches: record.wins + record.losses,
        badges: archived
          ? [
              `${finalRank.rankTier} finisher`,
              ...(["Season champion", "Season runner-up", "Season bronze"][
                index
              ]
                ? [
                    ["Season champion", "Season runner-up", "Season bronze"][
                      index
                    ],
                  ]
                : []),
            ]
          : [],
      };
    });
  return { season, archived, rows };
}

export function startSeasonWorker() {
  let running;
  const tick = () => {
    if (running) return;
    running = closeExpiredSeasons()
      .catch((error) => console.error("Season closure failed", error.message))
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(tick, 30_000);
  timer.unref();
  tick();
  return async () => {
    clearInterval(timer);
    await running;
  };
}
