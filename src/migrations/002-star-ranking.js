import mongoose from "mongoose";
import { Migration } from "../models/index.js";
import { lockRatings } from "../services/ratings.js";
import { ensureRankings } from "../services/ranking.js";
export async function migrateStarRanking() {
  return mongoose.connection.transaction(async (session) => {
    await lockRatings(session);
    if (await Migration.exists({ key: "002-star-ranking" }).session(session))
      return { alreadyApplied: true };
    const users = await ensureRankings(session);
    await Migration.create(
      [{ key: "002-star-ranking", appliedAt: new Date() }],
      { session },
    );
    return {
      profilesCreatedOrPreserved: users.length,
      historicalResultsReplayed: false,
    };
  });
}
