import { Router } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { admin, ensure, validate } from "../middleware/security.js";
import {
  User,
  Settings,
  Match,
  Event,
  EventRegistration,
  Team,
} from "../models/index.js";
import {
  PlayerRanking,
  RankingHistory,
  RankingSeason,
  RankingAdjustment,
  SeasonRanking,
} from "../models/ranking.js";
import {
  initialRanking,
  rankFor,
  TIERS,
  RULES,
  balancedFour,
} from "../domain/ranking.js";
import { lockRatings } from "../services/ratings.js";
import { rebuildStarRankings } from "../services/ranking.js";
import { audit, publish } from "../services/notifications.js";
import { eventController } from "../controllers/events.js";
import {
  pickleQueController,
  pickleQueReviewSchema,
} from "../controllers/pickle-que.js";
const id = z.string().regex(/^[a-f\d]{24}$/i);
const reason = z.string().trim().min(3).max(500);
const ruleSchema = z
  .object({
    normalPoints: z.number().int().min(1).max(99),
    strongerPoints: z.number().int().min(1).max(99),
    strongerGap: z.number().min(1).max(2000),
    placementK: z.number().min(1).max(128),
    regularK: z.number().min(1).max(128),
    placementMatches: z.number().int().min(1).max(100),
  })
  .strict();
function checkedId(value) {
  ensure(id.safeParse(value).success, "Invalid identifier");
  return value;
}
async function visible(req) {
  return (
    req.user.role === "admin" ||
    !!(await Settings.findOne({ key: "global" }).lean())?.showRankingMMR
  );
}
function safeState(state, show) {
  const { mmr, ...rest } = state;
  return show ? { ...rest, mmr } : rest;
}
function safeHistory(row, show) {
  const { mmrChanged, expectedScore, kFactor, ...rest } = row;
  return {
    ...rest,
    before: safeState(row.before, show),
    after: safeState(row.after, show),
    ...(show ? { mmrChanged, expectedScore, kFactor } : {}),
  };
}
export function rankingRoutes() {
  const r = Router();
  r.get(
    "/admin/ranking/players/:id/pickle-que-review",
    admin,
    pickleQueController.get,
  );
  r.post(
    "/admin/ranking/players/:id/pickle-que-review",
    admin,
    validate(pickleQueReviewSchema),
    pickleQueController.save,
  );
  r.get("/ranking/leaderboard", async (req, res) => {
    const query = z
      .object({
        period: z
          .enum(["current", "all-time", "month", "season", "event"])
          .default("current"),
        seasonId: id.optional(),
        eventId: id.optional(),
        tier: z.enum(TIERS).optional(),
        search: z.string().max(100).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .safeParse(req.query);
    ensure(query.success, "Invalid leaderboard filters");
    const q = query.data,
      show = await visible(req);
    ensure(q.period !== "event" || q.eventId, "Select an event");
    if (q.period === "event")
      ensure(
        await Event.exists({
          _id: q.eventId,
          ...(req.user.role === "admin" ? {} : { status: { $ne: "draft" } }),
        }),
        "Event not found",
        404,
      );
    let profiles = await PlayerRanking.find()
      .populate("userId", "fullName profileImage active role")
      .lean();
    if (q.eventId) {
      const participants = await EventRegistration.find({
        eventId: q.eventId,
        registrationStatus: "confirmed",
      }).distinct("userId");
      const ids = new Set(participants.map(String));
      profiles = profiles.filter((p) => ids.has(String(p.userId?._id)));
    }
    let seasonId = q.seasonId;
    if (q.period === "season") {
      seasonId ||= String(
        (await RankingSeason.findOne({ status: "active" }))?._id || "",
      );
      ensure(id.safeParse(seasonId).success, "Select a season");
      const snapshots = await SeasonRanking.find({ seasonId }).lean();
      const states = new Map(
        snapshots.map((s) => [String(s.playerId), s.state]),
      );
      profiles = profiles
        .filter((p) => states.has(String(p.userId?._id)))
        .map((p) => ({ ...p, state: states.get(String(p.userId._id)) }));
    }
    const now = new Date();
    const historyFilter =
      q.period === "event"
        ? { kind: "match", eventId: q.eventId }
        : q.period === "month"
          ? {
              kind: "match",
              timestamp: {
                $gte: new Date(
                  Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
                ),
                $lte: now,
              },
            }
          : q.period === "season"
            ? { kind: "match", seasonId }
            : null;
    const performance = new Map();
    if (historyFilter)
      for (const h of await RankingHistory.find(historyFilter).lean()) {
        const key = String(h.playerId),
          s = performance.get(key) || { stars: 0, wins: 0, matches: 0 };
        s.stars += h.starsChanged;
        s.wins += Number(h.won);
        s.matches++;
        performance.set(key, s);
      }
    let rows = profiles
      .filter((p) => p.userId?.active && p.userId.role === "player")
      .map((p) => {
        const s = p.state,
          perf = performance.get(String(p.userId._id)) || {
            stars: 0,
            wins: 0,
            matches: 0,
          };
        const stars = ["month", "event"].includes(q.period)
          ? perf.stars
          : q.period === "all-time"
            ? s.lifetimeStars
            : s.rankStars;
        const wins = historyFilter ? perf.wins : s.totalWins,
          matches = historyFilter ? perf.matches : s.rankedMatches;
        return {
          playerId: String(p.userId._id),
          fullName: p.userId.fullName,
          profileImage: p.userId.profileImage,
          ...rankFor(q.period === "all-time" ? s.lifetimeStars : s.rankStars),
          totalStars: stars,
          totalWins: wins,
          rankedMatches: matches,
          totalLosses: matches - wins,
          winPercentage: matches ? (100 * wins) / matches : 0,
          mmr: s.mmr,
        };
      })
      .filter(
        (p) =>
          (!q.tier || p.rankTier === q.tier) &&
          (!q.search ||
            p.fullName.toLowerCase().includes(q.search.toLowerCase())),
      );
    rows.sort(
      (a, b) =>
        b.totalStars - a.totalStars ||
        (q.period === "event" ? b.totalWins - a.totalWins : b.mmr - a.mmr) ||
        b.totalWins - a.totalWins ||
        a.playerId.localeCompare(b.playerId),
    );
    const total = rows.length;
    rows = rows
      .slice((q.page - 1) * q.limit, q.page * q.limit)
      .map((row, i) => {
        const { mmr, ...rest } = row;
        return {
          ...rest,
          position: (q.page - 1) * q.limit + i + 1,
          ...(show ? { mmr } : {}),
        };
      });
    res.json({
      rows,
      total,
      page: q.page,
      label:
        q.period === "event"
          ? "Net stars earned in this event"
          : q.period === "month"
            ? "Monthly net stars earned (UTC)"
            : q.period === "all-time"
              ? "Lifetime match stars (resets excluded)"
              : "Cumulative rank stars",
    });
  });
  r.get("/ranking/players/:id", async (req, res) => {
    const playerId = checkedId(req.params.id),
      user = await User.findById(playerId)
        .select("fullName profileImage")
        .lean();
    ensure(user, "Player not found", 404);
    const profile = await PlayerRanking.findOne({ userId: playerId }).lean();
    const state = profile?.state || initialRanking();
    res.json({
      user,
      profile: safeState(state, await visible(req)),
      highestRank: rankFor(state.highestRank),
      winPercentage: state.rankedMatches
        ? (state.totalWins / state.rankedMatches) * 100
        : 0,
    });
  });
  r.get("/ranking/players/:id/history", async (req, res) => {
    const playerId = checkedId(req.params.id),
      show = await visible(req);
    const q = z
      .object({
        page: z.coerce.number().int().min(1).default(1),
        seasonId: id.optional(),
      })
      .safeParse(req.query);
    ensure(q.success, "Invalid history filters");
    const filter = {
      playerId,
      ...(q.data.seasonId ? { seasonId: q.data.seasonId } : {}),
    };
    const rows = await RankingHistory.find(filter)
      .sort({ timestamp: -1, _id: -1 })
      .skip((q.data.page - 1) * 50)
      .limit(50)
      .lean();
    res.json({
      rows: rows.map((h) => safeHistory(h, show)),
      total: await RankingHistory.countDocuments(filter),
      page: q.data.page,
    });
  });
  r.get("/ranking/players/:id/statistics", async (req, res) => {
    const playerId = checkedId(req.params.id),
      p = await PlayerRanking.findOne({ userId: playerId }).lean();
    ensure(await User.exists({ _id: playerId }), "Player not found", 404);
    const s = p?.state || initialRanking();
    const rows = await RankingHistory.find({ playerId, kind: "match" })
      .sort({ timestamp: -1 })
      .limit(100)
      .lean();
    const ids = await RankingHistory.find({ playerId, kind: "match" }).distinct(
      "matchId",
    );
    const games = await Match.aggregate([
      { $match: { _id: { $in: ids } } },
      { $group: { _id: null, count: { $sum: { $size: "$scores" } } } },
    ]);
    res.json({
      ...safeState(s, await visible(req)),
      totalGames: games[0]?.count || 0,
      winPercentage: s.rankedMatches
        ? (100 * s.totalWins) / s.rankedMatches
        : 0,
      recentResults: rows.map((h) => ({
        matchId: h.matchId,
        won: h.won,
        timestamp: h.timestamp,
      })),
    });
  });
  r.get("/ranking/seasons", async (req, res) =>
    res.json({
      seasons: await RankingSeason.find().sort({ startDate: -1 }).lean(),
    }),
  );
  r.get("/admin/ranking/settings", admin, async (req, res) => {
    const settings = await Settings.findOne({ key: "global" });
    res.json({
      showMMR: settings?.showRankingMMR || false,
      rules: RULES,
      tiers: TIERS,
    });
  });
  r.patch(
    "/admin/ranking/settings",
    admin,
    validate(z.object({ showMMR: z.boolean(), reason }).strict()),
    async (req, res) => {
      await mongoose.connection.transaction(async (session) => {
        const settings = await lockRatings(session),
          before = settings.showRankingMMR;
        settings.showRankingMMR = req.body.showMMR;
        await settings.save({ session });
        await audit(
          req.user._id,
          "ranking-visibility",
          "Settings",
          "global",
          { showMMR: before },
          req.body,
          session,
        );
      });
      publish();
      res.json({ message: "Ranking visibility saved" });
    },
  );
  r.patch(
    "/admin/ranking/players/:id",
    admin,
    validate(
      z
        .object({ rankStars: z.number().int().min(0).max(1000000), reason })
        .strict(),
    ),
    async (req, res) => {
      const playerId = checkedId(req.params.id);
      await mongoose.connection.transaction(async (session) => {
        await lockRatings(session);
        ensure(
          await User.exists({ _id: playerId }).session(session),
          "Player not found",
          404,
        );
        const before = await PlayerRanking.findOne({ userId: playerId })
          .session(session)
          .lean();
        await RankingAdjustment.create(
          [{ playerId, actorId: req.user._id, ...req.body }],
          { session },
        );
        await rebuildStarRankings(session, { actorId: req.user._id });
        await audit(
          req.user._id,
          "adjust-rank-stars",
          "User",
          playerId,
          before,
          req.body,
          session,
        );
      });
      publish();
      res.json({ message: "Rank adjustment recorded" });
    },
  );
  r.post(
    "/admin/ranking/seasons",
    admin,
    validate(
      z
        .object({
          name: z.string().trim().min(1).max(100),
          endDate: z.coerce.date(),
          resetPolicy: z.enum(["none", "partial", "placement"]),
          keepFraction: z.number().min(0).max(1).default(0.5),
          rankingRules: ruleSchema.default(RULES),
          reason,
        })
        .strict(),
    ),
    async (req, res) => {
      const season = await mongoose.connection.transaction(async (session) => {
        await lockRatings(session);
        const now = new Date();
        ensure(req.body.endDate > now, "Season end must be in the future");
        await RankingSeason.updateMany(
          { status: "active" },
          { $set: { status: "closed", endDate: now } },
          { session },
        );
        const { reason: why, ...data } = req.body;
        const [created] = await RankingSeason.create(
          [{ ...data, startDate: now, status: "active" }],
          { session },
        );
        await rebuildStarRankings(session, { actorId: req.user._id });
        await audit(
          req.user._id,
          "start-ranking-season",
          "RankingSeason",
          created._id,
          null,
          { ...data, reason: why },
          session,
        );
        return created;
      });
      publish();
      res.status(201).json({ season });
    },
  );
  const resultSchema = z
    .object({
      scores: z
        .array(
          z
            .object({
              a: z.number().int().min(0).max(999),
              b: z.number().int().min(0).max(999),
            })
            .strict(),
        )
        .min(1)
        .max(3),
      revision: z.number().int().min(0),
      cascadeCorrection: z.boolean().default(false),
      reason: reason.optional(),
    })
    .strict();
  for (const action of ["finalize", "correct"])
    r.post(
      `/ranking/matches/:id/${action}`,
      admin,
      validate(resultSchema),
      async (req, res) => {
        checkedId(req.params.id);
        if (action === "correct")
          ensure(req.body.reason, "A correction reason is required");
        req.rankingAction = action;
        req.body.rated = true;
        return eventController.result(req, res);
      },
    );
  r.post(
    "/ranking/matchmaking/preview",
    admin,
    validate(
      z
        .object({
          eventId: id,
          playerIds: z.array(id).min(4).max(256),
          rotation: z
            .enum(["least-played", "registration"])
            .default("least-played"),
        })
        .strict(),
    ),
    async (req, res) => {
      const event = await Event.findById(req.body.eventId).lean();
      ensure(event, "Event not found", 404);
      ensure(
        !event.finalizedBatch,
        "Reopen teams before generating a new draft",
        409,
      );
      ensure(
        event.eventType !== "tournament" ||
          !["manual", "player-selected"].includes(event.teamMode),
        "Tournament partnerships are locked; manage seeded or manual teams in the event workspace",
      );
      ensure(
        new Set(req.body.playerIds).size === req.body.playerIds.length,
        "Duplicate players",
      );
      const registrations = await EventRegistration.find({
        eventId: event._id,
        registrationStatus: "confirmed",
        userId: { $in: req.body.playerIds },
      })
        .sort({ registeredAt: 1, _id: 1 })
        .lean();
      ensure(
        registrations.length === req.body.playerIds.length,
        "Select only confirmed event participants",
      );
      const profiles = await PlayerRanking.find({
        userId: { $in: req.body.playerIds },
      }).lean();
      const states = new Map(profiles.map((p) => [String(p.userId), p.state]));
      const prior = await Match.find({
        eventId: event._id,
        matchStatus: "finalized",
      })
        .populate("teamA teamB")
        .lean();
      const counts = new Map(),
        previous = [];
      for (const m of prior)
        for (const t of [m.teamA, m.teamB])
          if (t) {
            previous.push(t.players);
            for (const id of t.players)
              counts.set(String(id), (counts.get(String(id)) || 0) + 1);
          }
      let pool = registrations.map((r) => ({
        _id: String(r.userId),
        mmr: states.get(String(r.userId))?.mmr ?? 1000,
      }));
      if (req.body.rotation === "least-played")
        pool.sort(
          (a, b) => (counts.get(a._id) || 0) - (counts.get(b._id) || 0),
        );
      const selected = pool.splice(
          0,
          Math.min(Math.floor(pool.length / 4), event.courts.length) * 4,
        ),
        matches = [];
      // Group nearby MMR players after selecting by waiting priority.
      selected.sort((a, b) => a.mmr - b.mmr || a._id.localeCompare(b._id));
      while (selected.length)
        matches.push({
          ...balancedFour(selected.splice(0, 4), previous),
          courtNumber: event.courts[matches.length],
        });
      res.json({
        matches,
        waiting: pool.map((p) => p._id),
        eventId: event._id,
      });
    },
  );
  return r;
}
