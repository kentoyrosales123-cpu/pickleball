import mongoose from "mongoose";
import {
  Event,
  Match,
  Team,
  Migration,
  User,
  Settings,
} from "../models/index.js";
import { lockRatings, rebuildRatings } from "../services/ratings.js";
import { seedRating, DEFAULT_RATING_POLICY } from "../domain/ratings.js";
export const MIGRATION_KEY = "001-doubles-ratings";
export async function migrateRatings() {
  return mongoose.connection.transaction(async (session) => {
    await lockRatings(session);
    if (await Migration.exists({ key: MIGRATION_KEY }).session(session))
      return { alreadyApplied: true };
    await Settings.updateOne(
      { key: "global", rating: { $exists: false } },
      { $set: { rating: { ...DEFAULT_RATING_POLICY } } },
      { session },
    );
    // Historical results stay unrated until an administrator opts in explicitly.
    await Event.updateMany(
      { rated: { $exists: false } },
      { $set: { rated: false } },
      { session },
    );
    await Match.updateMany(
      { rated: { $exists: false } },
      { $set: { rated: false } },
      { session },
    );
    const users = await User.find().session(session).lean();
    const values = new Map(
      users.map((u) => [
        String(u._id),
        u.doublesRating ??
          seedRating(u.officialRanking || u.provisionalRanking),
      ]),
    );
    const teams = await Team.find({ combinedRating: { $exists: false } })
      .session(session)
      .lean();
    if (teams.length)
      await Team.bulkWrite(
        teams.map((t) => ({
          updateOne: {
            filter: { _id: t._id },
            update: {
              $set: {
                combinedRating: t.players.reduce(
                  (n, id) => n + (values.get(String(id)) ?? 100),
                  0,
                ),
              },
            },
          },
        })),
        { session },
      );
    const summary = await rebuildRatings(session, { notifications: false });
    await Migration.create([{ key: MIGRATION_KEY, appliedAt: new Date() }], {
      session,
    });
    return summary;
  });
}
