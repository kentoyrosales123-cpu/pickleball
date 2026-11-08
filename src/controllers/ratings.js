import mongoose from "mongoose";
import { z } from "zod";
import {
  User,
  PlayerRating,
  RatingHistory,
  RatingOverride,
  Settings,
  PlayerRankingHistory,
} from "../models/index.js";
import { ensure } from "../middleware/security.js";
import {
  lockRatings,
  policySnapshot,
  ensureRatingProfiles,
  rebuildRatings,
} from "../services/ratings.js";
import { seedRating } from "../domain/ratings.js";
import { audit, notify, publish } from "../services/notifications.js";

const thresholds = z
  .array(z.number().min(0).max(10000))
  .length(11)
  .refine(
    (a) => a.every((v, i) => i === 0 || v > a[i - 1]),
    "Thresholds must be strictly increasing",
  );
export const ratingSettingsSchema = z
  .object({
    enabled: z.boolean(),
    kFactor: z.number().min(1).max(128),
    minimumRatedMatches: z.number().int().min(10).max(1000),
    hysteresis: z.number().min(0).max(100),
    promotionThresholds: thresholds,
    demotionThresholds: thresholds,
  })
  .strict()
  .refine(
    (v) => v.demotionThresholds.every((n, i) => n <= v.promotionThresholds[i]),
    "Demotion thresholds must not exceed promotion thresholds",
  );
export const overrideSchema = z
  .object({
    action: z.enum(["manual", "release"]),
    ranking: z.number().int().min(1).max(12).optional(),
    rating: z.number().min(-10000).max(10000).optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict()
  .refine(
    (v) => v.action !== "manual" || v.ranking !== undefined,
    "A manual override requires a skill category",
  );
const pageSchema = z.object({
  pool: z.literal("doubles").default("doubles"),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export async function applyOverride(playerId, actor, body, auditAction) {
  await mongoose.connection.transaction(async (session) => {
    const settings = await lockRatings(session);
    const policy = policySnapshot(settings);
    const user = await User.findById(playerId).session(session);
    ensure(user, "Player not found", 404);
    await ensureRatingProfiles(session);
    const old = user.officialRanking || user.provisionalRanking;
    const action = body.action || "manual";
    const entry = {
      playerId: user._id,
      pool: "doubles",
      actorId: actor._id,
      action,
      reason: body.reason,
      timestamp: new Date(),
      policy,
      ...(action === "manual"
        ? {
            rank: body.ranking,
            rating: body.rating ?? seedRating(body.ranking),
          }
        : {}),
    };
    const [override] = await RatingOverride.create([entry], { session });
    await rebuildRatings(session, { notifications: false });
    const updated = await User.findById(user._id).session(session);
    await PlayerRankingHistory.create(
      [
        {
          playerId: user._id,
          oldRanking: old,
          newRanking: updated.officialRanking || updated.provisionalRanking,
          changedBy: actor._id,
          reason: body.reason,
        },
      ],
      { session },
    );
    await audit(
      actor._id,
      auditAction ||
        (action === "manual" ? "override-rating" : "release-rating-override"),
      "User",
      user._id,
      { ranking: old, rating: user.doublesRating },
      { ...entry, overrideId: override._id },
      session,
    );
    await notify(
      [user._id],
      action === "manual"
        ? "Ranking manually overridden"
        : "Automatic ranking resumed",
      `Your club documented this change: ${body.reason}`,
      "ranking",
      session,
    );
  });
  publish();
}
export const ratingController = {
  me: async (req, res) => {
    const input = pageSchema.safeParse(req.query);
    ensure(input.success, "Invalid rating pool or pagination");
    const { pool, page, limit } = input.data;
    const result = await mongoose.connection.transaction(async (session) => {
      const player = await User.findById(req.user._id).session(session);
      const profile = await PlayerRating.findOne({ playerId: player._id, pool })
        .session(session)
        .lean();
      const settings = await Settings.findOne({ key: "global" }).session(
        session,
      );
      const history = await RatingHistory.find({ playerId: player._id, pool })
        .sort({ timestamp: -1, sequence: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("matchId", "eventId completedAt")
        .session(session)
        .lean();
      const total = await RatingHistory.countDocuments({
        playerId: player._id,
        pool,
      }).session(session);
      return {
        pool,
        profile: profile || {
          rating:
            player.doublesRating ??
            seedRating(player.officialRanking || player.provisionalRanking),
          rank: player.officialRanking || player.provisionalRanking,
          ratedMatches: 0,
          automaticConfirmed: false,
          manualLocked: false,
          baselineRating: seedRating(
            player.officialRanking || player.provisionalRanking,
          ),
        },
        history,
        page,
        limit,
        total,
        hasMore: page * limit < total,
        settings: policySnapshot(settings),
      };
    });
    res.json(result);
  },
  settings: async (req, res) =>
    res.json({
      rating: policySnapshot(await Settings.findOne({ key: "global" })),
    }),
  updateSettings: async (req, res) => {
    await mongoose.connection.transaction(async (session) => {
      const settings = await lockRatings(session),
        before = policySnapshot(settings);
      settings.rating = req.body;
      await settings.save({ session });
      await audit(
        req.user._id,
        "configure-automatic-ratings",
        "Settings",
        "global",
        before,
        req.body,
        session,
      );
    });
    publish();
    res.json({
      rating: req.body,
      message:
        "Automatic rating settings saved. Changes apply to newly rated results.",
    });
  },
  override: async (req, res) => {
    await applyOverride(req.params.id, req.user, req.body);
    res.json({
      message:
        req.body.action === "release"
          ? "Manual override released"
          : "Manual override saved",
    });
  },
  recalculate: async (req, res) => {
    const summary = await mongoose.connection.transaction(async (session) => {
      await lockRatings(session);
      const summary = await rebuildRatings(session);
      await audit(
        req.user._id,
        "recalculate-ratings",
        "RatingPool",
        "doubles",
        null,
        { ...summary, reason: req.body.reason },
        session,
      );
      return summary;
    });
    publish();
    res.json(summary);
  },
};
