import mongoose from "mongoose";
import { z } from "zod";
import { User } from "../models/index.js";
import { PlayerRanking, RankingAdjustment } from "../models/ranking.js";
import { TIERS, initialRanking, rankFor } from "../domain/ranking.js";
import { ensure } from "../middleware/security.js";
import { lockRatings } from "../services/ratings.js";
import { rebuildStarRankings } from "../services/ranking.js";
import { audit, notify, publish } from "../services/notifications.js";
const id = z.string().regex(/^[a-f\d]{24}$/i);
export const pickleQueReviewSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    targetRank: z
      .object({
        tier: z.enum(TIERS),
        division: z.enum(["III", "II", "I"]).nullable(),
        stars: z.number().int().min(0).max(999865),
      })
      .strict()
      .refine(
        (v) =>
          v.tier === "Legend"
            ? v.division === null
            : v.division !== null && v.stars < 5,
        "Choose a division and 0–4 stars, or Legend with no division",
      ),
    stats: z
      .object({
        profileUrl: z
          .url()
          .max(1000)
          .refine((value) => {
            try {
              const url = new URL(value);
              return (
                url.protocol === "https:" && !url.username && !url.password
              );
            } catch {
              return false;
            }
          }, "Use an HTTPS profile link without embedded credentials"),
        accountName: z.string().trim().min(1).max(100),
        observedOn: z.iso
          .date()
          .refine(
            (value) => value <= new Date().toISOString().slice(0, 10),
            "Stats date cannot be in the future",
          ),
        wins: z.number().int().min(0).max(1000000),
        losses: z.number().int().min(0).max(1000000),
        displayedRating: z.string().trim().max(100).default(""),
        notes: z.string().trim().max(1000).default(""),
      })
      .strict()
      .refine(
        (v) => v.wins + v.losses > 0,
        "Enter at least one completed match",
      ),
    reason: z.string().trim().min(3).max(500),
    confirmed: z.literal(true),
  })
  .strict();
async function findPlayer(value, session = null) {
  ensure(id.safeParse(value).success, "Invalid player identifier");
  const player = await User.findById(value)
    .select("fullName role")
    .session(session)
    .lean();
  ensure(player && player.role === "player", "Player not found", 404);
  return player;
}
export const pickleQueController = {
  get: async (req, res) => {
    const player = await findPlayer(req.params.id);
    const profile = await PlayerRanking.findOne({ userId: player._id }).lean();
    const pageInput = z.coerce
      .number()
      .int()
      .min(1)
      .max(100000)
      .safeParse(req.query.page || 1);
    ensure(pageInput.success, "Invalid page");
    const filter = {
      playerId: player._id,
      "externalReview.source": "pickle-que",
    };
    const reviews = await RankingAdjustment.find(filter)
      .sort({ timestamp: -1, _id: -1 })
      .skip((pageInput.data - 1) * 20)
      .limit(20)
      .populate("actorId", "fullName")
      .lean();
    res.json({
      player,
      profile: profile?.state || initialRanking(),
      version: profile?.version || 0,
      reviews,
      page: pageInput.data,
      total: await RankingAdjustment.countDocuments(filter),
    });
  },
  save: async (req, res) => {
    let result;
    await mongoose.connection.transaction(async (session) => {
      await lockRatings(session);
      const player = await findPlayer(req.params.id, session);
      const profile = await PlayerRanking.findOne({ userId: player._id })
        .session(session)
        .lean();
      ensure(
        (profile?.version || 0) === req.body.expectedVersion,
        "This player's ranking changed. Reopen the review and check the latest rank before saving.",
        409,
      );
      const before = profile?.state || initialRanking(),
        { targetRank, stats, reason } = req.body;
      const rankStars =
        targetRank.tier === "Legend"
          ? 135 + targetRank.stars
          : TIERS.indexOf(targetRank.tier) * 15 +
            ["III", "II", "I"].indexOf(targetRank.division) * 5 +
            targetRank.stars;
      ensure(
        rankStars !== before.rankStars,
        "Choose a different rank to record an adjustment",
      );
      const matches = stats.wins + stats.losses;
      const externalReview = {
        ...stats,
        source: "pickle-que",
        entryMethod: "admin-entered",
        matches,
        winPercentage: (stats.wins / matches) * 100,
        previousRankStars: before.rankStars,
      };
      const [entry] = await RankingAdjustment.create(
        [
          {
            playerId: player._id,
            actorId: req.user._id,
            rankStars,
            reason,
            externalReview,
          },
        ],
        { session },
      );
      await rebuildStarRankings(session, { actorId: req.user._id });
      await audit(
        req.user._id,
        "pickle-que-rank-review",
        "User",
        player._id,
        { rankStars: before.rankStars, ...rankFor(before.rankStars) },
        {
          adjustmentId: entry._id,
          rankStars,
          ...rankFor(rankStars),
          externalReview,
          reason,
        },
        session,
      );
      await notify(
        [player._id],
        "Rank reviewed using Pickle Que stats",
        `Your administrator assigned ${rankFor(rankStars).rankTier} ${rankFor(rankStars).rankDivision || ""} (${rankStars} total stars). Reason: ${reason}`,
        "star-ranking",
        session,
      );
      result = {
        message: "Pickle Que review and rank adjustment saved",
        adjustmentId: entry._id,
        rankStars,
        ...rankFor(rankStars),
      };
    });
    publish();
    res.status(201).json(result);
  },
};
