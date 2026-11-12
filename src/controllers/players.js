import { lockRatings } from "../services/ratings.js";
import mongoose from "mongoose";
import {
  User,
  Event,
  Match,
  EventRegistration,
  PlayerRankingHistory,
  AuditLog,
  Notification,
  Settings,
} from "../models/index.js";
import { publicUser, ensure } from "../middleware/security.js";
import { playerStats } from "../services/stats.js";
import { audit, notify, publish } from "../services/notifications.js";
import { applyOverride } from "./ratings.js";
import { numericalRating } from "../domain/ratings.js";
export const playerController = {
  profile: async (req, res) => {
    Object.assign(req.user, req.body);
    await req.user.save();
    res.json({ user: publicUser(req.user) });
  },
  stats: async (req, res) => res.json(await playerStats(req.user._id)),
  history: async (req, res) => {
    const stats = await playerStats(req.user._id);
    const users = await User.find({
      _id: { $in: stats.history.flatMap((m) => [m.teammate, ...m.opponents]) },
    })
      .select("fullName")
      .lean();
    const names = Object.fromEntries(
      users.map((u) => [String(u._id), u.fullName]),
    );
    res.json({ matches: stats.history.reverse(), names });
  },
  leaderboard: async (req, res) => {
    const settings = (await Settings.findOne({ key: "global" })) || {
      leaderboardOrder: "wins",
      minimumMatches: 5,
    };
    const since =
      req.query.period === "month"
        ? new Date(
            Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
          )
        : req.query.period === "year"
          ? new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1))
          : undefined;
    const players = await User.find({ active: true, role: "player" })
      .select(
        "fullName username officialRanking provisionalRanking rankingStatus profileImage doublesRating doublesRatedMatches automaticRankingStatus rankingOverride",
      )
      .lean();
    const rows = [];
    for (const p of players) {
      if (
        req.query.rank &&
        Number(req.query.rank) !== (p.officialRanking || p.provisionalRanking)
      )
        continue;
      const s = await playerStats(p._id, {
        since,
        type: ["open-play", "tournament"].includes(req.query.type)
          ? req.query.type
          : undefined,
      });
      rows.push({
        ...p,
        matches: s.matches,
        wins: s.wins,
        losses: s.losses,
        winRate: s.winRate,
        points: s.tournamentPoints,
        rating: numericalRating(p),
      });
    }
    const key = settings.leaderboardOrder;
    res.json({
      players: rows
        .filter(
          (p) => key !== "winRate" || p.matches >= settings.minimumMatches,
        )
        .sort(
          (a, b) =>
            b[key] - a[key] ||
            b.wins - a.wins ||
            a.fullName.localeCompare(b.fullName),
        ),
      settings,
    });
  },
  notifications: async (req, res) =>
    res.json({
      notifications: await Notification.find({ userId: req.user._id })
        .sort({ createdAt: -1 })
        .limit(100),
    }),
  readNotification: async (req, res) => {
    await Notification.updateOne(
      { _id: req.params.id, userId: req.user._id },
      { isRead: true },
    );
    res.json({ message: "Marked as read" });
  },
  rankingHistory: async (req, res) =>
    res.json({
      history: await PlayerRankingHistory.find({ playerId: req.user._id }).sort(
        { changedAt: -1 },
      ),
    }),
  players: async (req, res) =>
    res.json({
      players: await User.find(
        req.user.role === "super-admin" ? {} : { role: "player" },
      )
        .select(
          req.user.role === "super-admin"
            ? "fullName username email officialRanking provisionalRanking rankingStatus active role createdAt doublesRating doublesRatedMatches automaticRankingStatus rankingOverride"
            : "fullName officialRanking provisionalRanking active role doublesRating",
        )
        .sort({ createdAt: -1 })
        .limit(1000),
    }),
  ranking: async (req, res) => {
    await applyOverride(
      req.params.id,
      req.user,
      { ...req.body, action: "manual" },
      "confirm-ranking",
    );
    res.json({
      message: "Ranking confirmed with a documented manual override",
    });
  },
  changeRole: async (req, res) => {
    ensure(
      String(req.user._id) !== req.params.id,
      "You cannot change your own role",
    );
    await mongoose.connection.transaction(async (session) => {
      await lockRatings(session);
      ensure(
        await User.exists({
          _id: req.user._id,
          role: "super-admin",
          active: true,
        }).session(session),
        "Super Admin access required",
        403,
      );
      const user = await User.findById(req.params.id)
        .select("+tokenVersion")
        .session(session);
      ensure(user, "User not found", 404);
      const before = user.role;
      if (before === req.body.role) return;
      if (before === "super-admin" && user.active)
        ensure(
          (await User.countDocuments({
            role: "super-admin",
            active: true,
          }).session(session)) > 1,
          "Keep at least one active Super Admin",
          409,
        );
      user.role = req.body.role;
      user.tokenVersion++;
      await user.save({ session });
      await audit(
        req.user._id,
        "change-role",
        "User",
        user._id,
        { role: before },
        { role: user.role },
        session,
      );
    });
    publish();
    res.json({ message: "Role updated. This user must sign in again." });
  },
  activate: async (req, res) => {
    ensure(
      String(req.user._id) !== req.params.id,
      "You cannot deactivate yourself",
    );
    await mongoose.connection.transaction(async (session) => {
      await lockRatings(session);
      ensure(
        await User.exists({
          _id: req.user._id,
          role: "super-admin",
          active: true,
        }).session(session),
        "Super Admin access required",
        403,
      );
      const user = await User.findById(req.params.id).session(session);
      ensure(user, "User not found", 404);
      if (user.role === "super-admin" && user.active && !req.body.active)
        ensure(
          (await User.countDocuments({
            role: "super-admin",
            active: true,
          }).session(session)) > 1,
          "Keep at least one active Super Admin",
          409,
        );
      const before = user.active;
      user.active = req.body.active;
      user.tokenVersion =
        (await User.findById(user._id).select("+tokenVersion").session(session))
          .tokenVersion + 1;
      await user.save({ session });
      await audit(
        req.user._id,
        "set-active",
        "User",
        user._id,
        { active: before },
        req.body,
        session,
      );
    });
    res.json({ message: "Account updated" });
  },
  dashboard: async (req, res) => {
    const players = await User.find({ role: "player" })
      .select("createdAt active officialRanking provisionalRanking")
      .lean();
    const events = await Event.find()
      .select(
        "eventName eventType status confirmedCount capacity startDateTime",
      )
      .lean();
    const rankingDistribution = Array.from(
      { length: 12 },
      (_, i) =>
        players.filter(
          (p) => (p.officialRanking || p.provisionalRanking) === i + 1,
        ).length,
    );
    const growth = {};
    players.forEach((p) => {
      const key = p.createdAt.toISOString().slice(0, 7);
      growth[key] = (growth[key] || 0) + 1;
    });
    res.json({
      totalPlayers: players.length,
      activePlayers: players.filter((p) => p.active).length,
      openPlay: events.filter((e) => e.eventType === "open-play").length,
      tournaments: events.filter((e) => e.eventType === "tournament").length,
      upcoming: events.filter(
        (e) =>
          e.startDateTime > new Date() &&
          !["draft", "cancelled"].includes(e.status),
      ).length,
      completedMatches: await Match.countDocuments({
        matchStatus: "finalized",
      }),
      pending: await EventRegistration.countDocuments({
        registrationStatus: "waitlisted",
      }),
      provisional: players.filter((p) => !p.officialRanking).length,
      rankingDistribution,
      growth,
      events,
    });
  },
  audit: async (req, res) =>
    res.json({
      logs: await AuditLog.find()
        .populate("actorId", "fullName")
        .sort({ timestamp: -1 })
        .limit(200),
    }),
  settings: async (req, res) =>
    res.json({
      settings: (await Settings.findOne({ key: "global" })) || {
        leaderboardOrder: "wins",
        minimumMatches: 5,
      },
    }),
  updateSettings: async (req, res) => {
    await mongoose.connection.transaction(async (session) => {
      const before = await Settings.findOneAndUpdate(
        { key: "global" },
        req.body,
        { upsert: true, session },
      );
      await audit(
        req.user._id,
        "settings",
        "Settings",
        "global",
        before?.toObject(),
        req.body,
        session,
      );
    });
    res.json({ message: "Settings saved" });
  },
};
