import { queueController as queue } from "../controllers/queue.js";
import { rankingRoutes } from "./ranking.js";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { auth, admin, superAdmin, validate } from "../middleware/security.js";
import {
  authController,
  registrationSchema,
  createUserSchema,
  loginSchema,
  password,
} from "../controllers/auth.js";
import { eventController as e, eventSchema } from "../controllers/events.js";
import { playerController as p } from "../controllers/players.js";
import { Settings, RANKINGS } from "../models/index.js";
import {
  ratingController as ratings,
  ratingSettingsSchema,
  overrideSchema,
} from "../controllers/ratings.js";
const id = z.string().regex(/^[a-f\d]{24}$/i);
export function api(config) {
  const r = Router(),
    a = authController(config),
    signedIn = auth(config);
  const authLimit = rateLimit({
    windowMs: 15 * 60_000,
    limit: config.NODE_ENV === "test" ? 1000 : 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
      message: "Too many sign-in or recovery attempts. Please try again later.",
    },
  });
  r.get("/rankings", (req, res) => res.json({ rankings: RANKINGS }));
  r.get("/public/events", e.list);
  r.post("/auth/register", authLimit, validate(registrationSchema), a.register);
  r.post("/auth/login", authLimit, validate(loginSchema), a.login);
  r.post(
    "/auth/forgot-password",
    authLimit,
    validate(z.object({ email: z.email().transform((v) => v.toLowerCase()) })),
    a.forgot,
  );
  r.post(
    "/auth/action",
    authLimit,
    validate(
      z.discriminatedUnion("purpose", [
        z.object({
          purpose: z.literal("verify"),
          token: z.string().length(64),
        }),
        z.object({
          purpose: z.literal("reset"),
          token: z.string().length(64),
          password,
        }),
      ]),
    ),
    a.consume,
  );
  r.use(signedIn);
  r.use(async (req, res, next) => {
    if (
      !["admin", "super-admin"].includes(req.user.role) &&
      !(await Settings.findOne({ key: "global" }).lean())?.showRankingMMR
    ) {
      const json = res.json.bind(res);
      res.json = (value) =>
        json(
          JSON.parse(
            JSON.stringify(value, (key, value) =>
              ["combinedRating", "matchmakingMMR"].includes(key)
                ? undefined
                : value,
            ),
          ),
        );
    }
    next();
  });
  r.use(rankingRoutes());
  r.get("/auth/me", a.me);
  r.post("/auth/logout", a.logout);
  r.post("/auth/resend-verification", authLimit, a.resend);
  r.get("/players/me", a.me);
  r.put(
    "/players/me",
    validate(
      z.object({
        fullName: z.string().trim().min(2).max(100),
        phone: z.string().max(30).optional(),
        gender: z.string().max(30).optional(),
        dateOfBirth: z.iso.date().optional(),
        profileImage: z
          .union([z.literal(""), z.url().startsWith("https://")])
          .optional(),
      }),
    ),
    p.profile,
  );
  r.get("/players/me/stats", p.stats);
  r.get("/players/me/matches", p.history);
  r.get("/players/me/rankings", p.rankingHistory);
  r.get("/players/me/rating", ratings.me);
  r.get("/players/me/rating-history", ratings.me);
  r.get("/leaderboard", p.leaderboard);
  r.get("/notifications", p.notifications);
  r.put("/notifications/:id/read", p.readNotification);
  r.get("/events", e.list);
  r.get("/events/:id", e.detail);
  r.post("/events", admin, validate(eventSchema), e.create);
  r.put("/events/:id", admin, validate(eventSchema), e.update);
  r.delete("/events/:id", admin, e.remove);
  r.post("/events/:id/register", e.register);
  r.delete("/events/:id/register", e.cancel);
  r.get("/events/:id/participants", admin, e.participants);
  r.post(
    "/events/:id/participants",
    admin,
    validate(z.object({ userId: id })),
    e.addParticipant,
  );
  r.delete("/events/:id/participants/:userId", admin, e.removeParticipant);
  r.get("/events/:id/queue", admin, queue.get);
  r.post("/events/:id/queue/prepare", admin, queue.prepare);
  r.post(
    "/events/:id/queue/:matchId/start",
    admin,
    validate(z.object({ court: z.string().min(1).max(30) })),
    queue.start,
  );
  r.delete("/events/:id/queue/:matchId", admin, queue.cancel);
  r.get("/events/:id/teams", e.teams);
  r.post(
    "/events/:id/generate-teams",
    admin,
    validate(z.object({ mode: z.enum(["random", "balanced", "same-rank"]) })),
    e.generateTeams,
  );
  r.put(
    "/events/:id/teams",
    admin,
    validate(
      z.object({
        teams: z
          .array(z.tuple([id, id]))
          .min(1)
          .max(128),
      }),
    ),
    e.saveTeams,
  );
  r.post(
    "/events/:id/finalize-teams",
    admin,
    validate(z.object({ allowSubstitutes: z.boolean().default(false) })),
    e.finalizeTeams,
  );
  r.post(
    "/events/:id/reopen-teams",
    admin,
    validate(z.object({ confirm: z.literal(true) })),
    e.reopenTeams,
  );
  r.get("/events/:id/partner-requests", e.partnerOptions);
  r.post(
    "/events/:id/partner-requests",
    validate(z.object({ partnerId: id })),
    e.requestPartner,
  );
  r.put(
    "/events/:id/partner-requests/:proposalId",
    admin,
    validate(z.object({ approve: z.boolean() })),
    e.reviewPartner,
  );
  r.post("/events/:id/generate-matches", admin, e.generateMatches);
  r.get("/events/:id/matches", e.matches);
  r.post("/events/:id/enable-rankings", admin, e.enableRankings);
  const result = validate(
    z.object({
      scores: z
        .array(
          z.object({
            a: z.number().int().min(0).max(999),
            b: z.number().int().min(0).max(999),
          }),
        )
        .min(1)
        .max(3),
      revision: z.number().int().min(0),
      cascadeCorrection: z.boolean().default(false),
      rated: z.boolean().optional(),
    }),
  );
  r.post("/matches/:id/results", admin, result, e.result);
  r.put("/matches/:id/results", admin, result, e.result);
  r.delete(
    "/matches/:id/results",
    admin,
    validate(
      z.object({
        revision: z.number().int().min(0),
        reason: z.string().trim().min(3).max(500),
        cascadeCorrection: z.boolean().default(false),
      }),
    ),
    e.invalidateResult,
  );
  r.put(
    "/matches/:id/rating",
    admin,
    validate(
      z.object({
        rated: z.boolean(),
        revision: z.number().int().min(0),
        reason: z.string().trim().min(3).max(500),
      }),
    ),
    e.setRated,
  );
  r.put(
    "/matches/:id/schedule",
    admin,
    validate(
      z.object({
        startDateTime: z.coerce.date(),
        courtNumber: z.string().min(1).max(30),
      }),
    ),
    e.reschedule,
  );
  r.post("/tournaments/:id/generate-bracket", admin, e.generateMatches);
  r.get("/tournaments/:id/bracket", e.bracket);
  r.get("/tournaments/:id/standings", e.bracket);
  r.get("/admin/dashboard", admin, p.dashboard);
  r.get("/admin/reports", admin, p.dashboard);
  r.get("/admin/players", admin, p.players);
  r.get("/admin/users", superAdmin, p.players);
  r.post(
    "/admin/players",
    superAdmin,
    validate(createUserSchema),
    a.createUser,
  );
  r.put(
    "/admin/users/:id/role",
    superAdmin,
    validate(z.object({ role: z.enum(["player", "admin", "super-admin"]) })),
    p.changeRole,
  );
  r.put(
    "/admin/players/:id/ranking",
    superAdmin,
    validate(
      z.object({
        ranking: z.coerce.number().int().min(1).max(12),
        reason: z.string().trim().min(3).max(500),
      }),
    ),
    p.ranking,
  );
  r.put(
    "/admin/players/:id/active",
    superAdmin,
    validate(z.object({ active: z.boolean() })),
    p.activate,
  );
  r.get("/admin/audit-logs", superAdmin, p.audit);
  r.get("/admin/settings", superAdmin, p.settings);
  r.get("/admin/ratings/settings", superAdmin, ratings.settings);
  r.put(
    "/admin/ratings/settings",
    superAdmin,
    validate(ratingSettingsSchema),
    ratings.updateSettings,
  );
  r.post(
    "/admin/ratings/recalculate",
    superAdmin,
    validate(z.object({ reason: z.string().trim().min(3).max(500) })),
    ratings.recalculate,
  );
  r.put(
    "/admin/players/:id/rating-override",
    superAdmin,
    validate(overrideSchema),
    ratings.override,
  );
  r.put(
    "/admin/settings",
    superAdmin,
    validate(
      z.object({
        leaderboardOrder: z.enum(["wins", "winRate", "points", "rating"]),
        minimumMatches: z.coerce.number().int().min(0).max(1000),
      }),
    ),
    p.updateSettings,
  );
  return r;
}
