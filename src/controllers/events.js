import { PlayerRanking } from "../models/ranking.js";
import { captureStarPolicy, rebuildStarRankings } from "../services/ranking.js";
import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  Event,
  EventRegistration,
  Team,
  Match,
  User,
  Tournament,
  TeamProposal,
} from "../models/index.js";
import { ensure } from "../middleware/security.js";
import { registerPlayer } from "../services/registration.js";
import {
  generateTeams,
  shuffle,
  roundRobin,
  scheduleRounds,
  rotatingMatchups,
} from "../services/teams.js";
import {
  buildBracket,
  advanceBracket,
  invalidateDescendants,
} from "../services/brackets.js";
import { scoreMatch } from "../services/scoring.js";
import {
  notify,
  audit,
  publish,
  publishRankingResult,
} from "../services/notifications.js";
import {
  lockRatings,
  captureRatingPolicy,
  rebuildRatings,
} from "../services/ratings.js";
import { numericalRating } from "../domain/ratings.js";
const date = z.coerce.date();
export const eventSchema = z
  .object({
    eventName: z.string().trim().min(3).max(120),
    eventType: z.enum(["open-play", "tournament"]),
    description: z.string().max(3000).default(""),
    location: z.string().trim().min(2).max(200),
    startDateTime: date,
    endDateTime: date,
    registrationOpen: date,
    registrationDeadline: date,
    capacity: z.coerce.number().int().min(4).max(256),
    minRanking: z.coerce.number().int().min(1).max(12),
    maxRanking: z.coerce.number().int().min(1).max(12),
    courts: z
      .array(z.string().trim().min(1).max(30))
      .min(1)
      .max(30)
      .refine(
        (v) => new Set(v).size === v.length,
        "Court names must be unique",
      ),
    fee: z.coerce.number().min(0).max(100000).default(0),
    waitlistEnabled: z.boolean().default(false),
    format: z.enum([
      "random",
      "balanced",
      "round-robin",
      "rotating",
      "single-elimination",
      "double-elimination",
      "group-knockout",
    ]),
    teamMode: z
      .enum(["random", "balanced", "same-rank", "manual", "player-selected"])
      .default("balanced"),
    targetPoints: z.coerce
      .number()
      .pipe(z.union([z.literal(11), z.literal(15), z.literal(21)])),
    winningMargin: z.coerce.number().int().min(1).max(10),
    bestOf: z.coerce.number().pipe(z.union([z.literal(1), z.literal(3)])),
    rounds: z.coerce.number().int().min(1).max(30),
    matchDuration: z.coerce.number().int().min(5).max(180),
    status: z.enum([
      "draft",
      "published",
      "registration-open",
      "registration-closed",
      "ongoing",
      "completed",
      "cancelled",
    ]),
    grandFinalReset: z.boolean().default(true),
    groupCount: z.coerce.number().int().min(2).max(8).default(2),
    rated: z.boolean().default(false),
  })
  .refine((v) => v.minRanking <= v.maxRanking, {
    message: "Minimum ranking exceeds maximum",
  })
  .refine(
    (v) =>
      v.registrationOpen < v.registrationDeadline &&
      v.registrationDeadline <= v.startDateTime &&
      v.startDateTime < v.endDateTime,
    {
      message:
        "Dates must be ordered: registration opens, deadline, start, end",
    },
  )
  .refine(
    (v) =>
      v.eventType === "tournament"
        ? [
            "single-elimination",
            "double-elimination",
            "round-robin",
            "group-knockout",
          ].includes(v.format)
        : ["random", "balanced", "round-robin", "rotating"].includes(v.format),
    { message: "Format does not apply to event type" },
  );
export async function getEvent(id, session) {
  const event = await Event.findById(id).session(session || null);
  ensure(event, "Event not found", 404);
  return event;
}
async function lockEvent(id, session, allowCompleted = false) {
  const event = await Event.findByIdAndUpdate(
    id,
    { $inc: { revision: 1 } },
    { returnDocument: "after", session },
  );
  ensure(event, "Event not found", 404);
  ensure(
    event.status !== "cancelled" &&
      (allowCompleted || event.status !== "completed"),
    "Event is closed",
  );
  return event;
}
async function participants(id, session) {
  const rows = await EventRegistration.find({
    eventId: id,
    registrationStatus: "confirmed",
  })
    .populate("userId")
    .session(session);
  const players = rows.map((r) => r.userId);
  const event = await Event.findById(id).session(session);
  if (event?.rated) {
    const profiles = await PlayerRanking.find({
      userId: { $in: players.map((p) => p._id) },
    })
      .session(session)
      .lean();
    const mmrs = new Map(profiles.map((p) => [String(p.userId), p.state.mmr]));
    for (const player of players)
      player.$locals.rankingMMR = mmrs.get(String(player._id)) ?? 1000;
  }
  return players;
}
export const eventController = {
  list: async (req, res) => {
    const filter = ["admin", "super-admin"].includes(req.user?.role)
      ? {}
      : { status: { $ne: "draft" } };
    const events = await Event.find(filter)
      .sort({ startDateTime: 1 })
      .limit(200)
      .lean();
    const registrations = req.user
      ? await EventRegistration.find({ userId: req.user._id }).lean()
      : [];
    res.json({
      events: events.map((e) => ({
        ...e,
        registration: registrations.find(
          (r) => String(r.eventId) === String(e._id),
        )?.registrationStatus,
      })),
    });
  },
  detail: async (req, res) => {
    const event = await getEvent(req.params.id);
    ensure(
      ["admin", "super-admin"].includes(req.user.role) ||
        event.status !== "draft",
      "Event not found",
      404,
    );
    res.json({ event });
  },
  create: async (req, res) => {
    const event = await mongoose.connection.transaction(async (session) => {
      const [event] = await Event.create(
        [{ ...req.body, createdBy: req.user._id }],
        { session },
      );
      await audit(
        req.user._id,
        "create",
        "Event",
        event._id,
        null,
        req.body,
        session,
      );
      if (event.status !== "draft")
        await notify(
          (
            await User.find({ active: true }).select("_id").session(session)
          ).map((u) => u._id),
          "New event",
          event.eventName,
          "event",
          session,
        );
      return event;
    });
    publish();
    res.status(201).json({ event });
  },
  update: async (req, res) => {
    const event = await mongoose.connection.transaction(async (session) => {
      const event = await getEvent(req.params.id, session);
      const before = event.toObject();
      ensure(
        req.body.capacity >= event.confirmedCount,
        "Capacity cannot be below confirmed registrations",
      );
      const players = await participants(event._id, session);
      ensure(
        players.every(
          (p) =>
            (p.officialRanking || p.provisionalRanking) >=
              req.body.minRanking &&
            (p.officialRanking || p.provisionalRanking) <= req.body.maxRanking,
        ),
        "New ranking limits exclude existing participants",
      );
      if (await Match.exists({ eventId: event._id }).session(session))
        for (const key of [
          "format",
          "targetPoints",
          "winningMargin",
          "bestOf",
          "matchDuration",
          "startDateTime",
          "endDateTime",
          "courts",
          "eventType",
        ])
          ensure(
            JSON.stringify(before[key]) === JSON.stringify(req.body[key]),
            `Cannot change ${key} after scheduling`,
          );
      Object.assign(event, req.body);
      event.revision++;
      await event.save({ session });
      if (before.rated !== event.rated)
        await Match.updateMany(
          {
            eventId: event._id,
            matchStatus: { $in: ["pending", "scheduled"] },
          },
          { $set: { rated: event.rated }, $unset: { ratingPolicy: 1 } },
          { session },
        );
      await audit(
        req.user._id,
        "update",
        "Event",
        event._id,
        before,
        req.body,
        session,
      );
      const newlyPublished =
        before.status === "draft" && event.status !== "draft";
      const recipients = newlyPublished
        ? (
            await User.find({ active: true }).select("_id").session(session)
          ).map((u) => ({ userId: u._id }))
        : await EventRegistration.find({
            eventId: event._id,
            registrationStatus: { $ne: "cancelled" },
          }).session(session);
      await notify(
        recipients.map((r) => r.userId),
        event.status === "cancelled"
          ? "Event cancelled"
          : newlyPublished
            ? "New event"
            : "Event updated",
        event.eventName,
        "event",
        session,
      );
      return event;
    });
    publish();
    res.json({ event });
  },
  remove: async (req, res) => {
    await mongoose.connection.transaction(async (session) => {
      await lockRatings(session);
      const event = await Event.findByIdAndUpdate(
        req.params.id,
        { $inc: { revision: 1 } },
        { returnDocument: "after", session },
      );
      ensure(event, "Event not found", 404);
      for (const model of [
        Match,
        Team,
        EventRegistration,
        TeamProposal,
        Tournament,
      ])
        await model.deleteMany({ eventId: event._id }, { session });
      await Event.deleteOne({ _id: event._id }, { session });
      await rebuildRatings(session);
      await rebuildStarRankings(session, { actorId: req.user._id });
      await audit(
        req.user._id,
        "delete",
        "Event",
        event._id,
        event.toObject(),
        null,
        session,
      );
    });
    publish();
    res.json({ message: "Event deleted" });
  },
  register: async (req, res) =>
    res.json({
      registration: await registerPlayer(req.params.id, req.user._id, req.user),
    }),
  cancel: async (req, res) =>
    res.json({
      registration: await registerPlayer(
        req.params.id,
        req.user._id,
        req.user,
        true,
      ),
    }),
  addParticipant: async (req, res) =>
    res.json({
      registration: await registerPlayer(
        req.params.id,
        req.body.userId,
        req.user,
      ),
    }),
  removeParticipant: async (req, res) =>
    res.json({
      registration: await registerPlayer(
        req.params.id,
        req.params.userId,
        req.user,
        true,
      ),
    }),
  participants: async (req, res) =>
    res.json({
      participants: await EventRegistration.find({ eventId: req.params.id })
        .populate(
          "userId",
          "fullName username officialRanking provisionalRanking rankingStatus doublesRating doublesRatedMatches",
        )
        .sort({ registeredAt: 1 }),
    }),
  teams: async (req, res) => {
    const event = await getEvent(req.params.id);
    const batch = ["admin", "super-admin"].includes(req.user.role)
      ? event.activeBatch
      : event.finalizedBatch;
    res.json({
      teams: batch
        ? await Team.find({
            eventId: event._id,
            generationBatchId: batch,
          }).populate(
            "players",
            "fullName officialRanking provisionalRanking doublesRating doublesRatedMatches",
          )
        : [],
      finalized: !!event.finalizedBatch,
    });
  },
  generateTeams: async (req, res) => {
    const result = await mongoose.connection.transaction(async (session) => {
      const event = await lockEvent(req.params.id, session);
      ensure(
        !event.finalizedBatch,
        "Official teams are locked. Create another event for a new assignment.",
      );
      ensure(
        event.eventType !== "tournament" ||
          !["manual", "player-selected"].includes(event.teamMode),
        "Tournament partnerships must be managed manually",
      );
      const players = await participants(event._id, session);
      ensure(
        players.length >= 2,
        "At least two confirmed players are required",
      );
      const previous = await Team.find({ eventId: event._id }).session(session);
      const result = generateTeams(
        players,
        req.body.mode,
        previous.map((t) => t.players),
      );
      const batch = randomUUID();
      await Team.deleteMany(
        { eventId: event._id, assignmentStatus: "draft" },
        { session },
      );
      const teams = await Team.insertMany(
        result.teams.map((t) => ({
          ...t,
          eventId: event._id,
          generationBatchId: batch,
        })),
        { session },
      );
      event.activeBatch = batch;
      await event.save({ session });
      await audit(
        req.user._id,
        "generate-teams",
        "Event",
        event._id,
        null,
        { mode: req.body.mode, batch },
        session,
      );
      return { teams, unassigned: result.unassigned, batch };
    });
    res.json(result);
  },
  saveTeams: async (req, res) => {
    await mongoose.connection.transaction(async (session) => {
      const event = await lockEvent(req.params.id, session);
      ensure(!event.finalizedBatch, "Official teams cannot be edited");
      const players = await participants(event._id, session);
      const ids = req.body.teams.flat();
      ensure(
        new Set(ids).size === ids.length,
        "A player appears more than once",
      );
      ensure(
        ids.every((id) => players.some((p) => String(p._id) === id)),
        "Teams must contain confirmed participants only",
      );
      const batch = randomUUID();
      await Team.deleteMany(
        { eventId: event._id, assignmentStatus: "draft" },
        { session },
      );
      await Team.insertMany(
        req.body.teams.map((pair) => ({
          eventId: event._id,
          generationBatchId: batch,
          players: pair,
          combinedRanking: pair.reduce((s, id) => {
            const p = players.find((p) => String(p._id) === id);
            return s + (p.officialRanking || p.provisionalRanking);
          }, 0),
          combinedRating: pair.reduce(
            (s, id) =>
              s + numericalRating(players.find((p) => String(p._id) === id)),
            0,
          ),
        })),
        { session },
      );
      event.activeBatch = batch;
      await event.save({ session });
      await audit(
        req.user._id,
        "edit-teams",
        "Event",
        event._id,
        null,
        req.body,
        session,
      );
    });
    res.json({ message: "Draft saved" });
  },
  finalizeTeams: async (req, res) => {
    await mongoose.connection.transaction(async (session) => {
      const event = await lockEvent(req.params.id, session);
      ensure(
        event.activeBatch && !event.finalizedBatch,
        "No draft is available",
      );
      const players = await participants(event._id, session);
      const teams = await Team.find({
        eventId: event._id,
        generationBatchId: event.activeBatch,
      }).session(session);
      ensure(teams.length >= 2, "At least two complete teams are required");
      const assigned = teams.flatMap((t) => t.players.map(String));
      const missing = players.filter((p) => !assigned.includes(String(p._id)));
      ensure(
        !missing.length || req.body.allowSubstitutes === true,
        "Unassigned players remain. Explicitly accept them as rotating substitutes.",
      );
      await Team.updateMany(
        { eventId: event._id, generationBatchId: event.activeBatch },
        { assignmentStatus: "finalized" },
        { session },
      );
      event.finalizedBatch = event.activeBatch;
      event.status = "registration-closed";
      await event.save({ session });
      await notify(
        players.map((p) => p._id),
        "Teams published",
        event.eventName,
        "teams",
        session,
      );
      await audit(
        req.user._id,
        "finalize-teams",
        "Event",
        event._id,
        null,
        { batch: event.activeBatch, substitutes: missing.map((p) => p._id) },
        session,
      );
    });
    publish();
    res.json({ message: "Teams finalized" });
  },
  generateMatches: async (req, res) => {
    await mongoose.connection.transaction(async (session) => {
      const event = await lockEvent(req.params.id, session);
      ensure(event.finalizedBatch, "Finalize teams first");
      ensure(
        !(await Match.exists({ eventId: event._id }).session(session)),
        "A schedule already exists",
        409,
      );
      let teams = await Team.find({
        eventId: event._id,
        generationBatchId: event.finalizedBatch,
      }).session(session);
      const roster = await participants(event._id, session);
      const strengths = new Map(roster.map((p) => [String(p._id), p]));
      for (const team of teams) {
        // Re-read current Elo before scheduling, rather than reusing an older draft's strength.
        if (team.players.every((id) => strengths.has(String(id)))) {
          team.combinedRating = team.players.reduce(
            (n, id) => n + numericalRating(strengths.get(String(id))),
            0,
          );
          await team.save({ session });
        }
      }
      if (event.eventType === "tournament")
        await buildBracket(event, teams, session);
      else {
        let rounds;
        if (["random", "rotating"].includes(event.format)) {
          const players = await participants(event._id, session);
          const counts = new Map(players.map((p) => [String(p._id), 0]));
          const previous = [];
          rounds = [];
          for (let r = 0; r < event.rounds; r++) {
            const active = shuffle(players)
              .sort(
                (a, b) => counts.get(String(a._id)) - counts.get(String(b._id)),
              )
              .slice(0, Math.floor(players.length / 4) * 4);
            active.forEach((p) =>
              counts.set(String(p._id), counts.get(String(p._id)) + 1),
            );
            const draft = generateTeams(
              active,
              event.format === "random" ? "random" : "balanced",
              previous,
            );
            previous.push(...draft.teams.map((t) => t.players));
            const roundTeams = await Team.insertMany(
              draft.teams.map((t) => ({
                ...t,
                eventId: event._id,
                generationBatchId: `${event.finalizedBatch}-round-${r + 1}`,
                roundNumber: r + 1,
                assignmentStatus: "finalized",
              })),
              { session },
            );
            if (event.format === "random") {
              const pairs = [];
              for (let i = 0; i < roundTeams.length; i += 2)
                pairs.push([roundTeams[i], roundTeams[i + 1]]);
              rounds.push(pairs);
            } else rounds.push(rotatingMatchups(roundTeams, rounds.flat()));
          }
        } else if (event.format === "round-robin")
          rounds = roundRobin(shuffle(teams));
        else
          rounds = Array.from({ length: event.rounds }, () => {
            const sorted =
              event.format === "balanced"
                ? shuffle(teams).sort(
                    (a, b) =>
                      (a.combinedRating ?? a.combinedRanking * 200) -
                      (b.combinedRating ?? b.combinedRanking * 200),
                  )
                : shuffle(teams);
            const pairs = [];
            for (let i = 0; i + 1 < sorted.length; i += 2)
              pairs.push([sorted[i], sorted[i + 1]]);
            return pairs;
          });
        let schedule;
        try {
          schedule = scheduleRounds(rounds, event);
        } catch (err) {
          ensure(false, err.message);
        }
        await Match.insertMany(
          schedule.map((m) => ({ ...m, rated: event.rated })),
          { session },
        );
      }
      const players = await participants(event._id, session);
      await notify(
        players.map((p) => p._id),
        "Schedule published",
        event.eventName,
        "schedule",
        session,
      );
      await audit(
        req.user._id,
        "generate-matches",
        "Event",
        event._id,
        null,
        { format: event.format },
        session,
      );
    });
    publish();
    res.json({ message: "Schedule generated" });
  },
  matches: async (req, res) => {
    const event = await getEvent(req.params.id);
    ensure(
      event.status !== "draft" ||
        ["admin", "super-admin"].includes(req.user.role),
      "Event not found",
      404,
    );
    res.json({
      matches: await Match.find({ eventId: event._id })
        .populate({
          path: "teamA teamB",
          populate: {
            path: "players",
            select: "fullName officialRanking provisionalRanking doublesRating",
          },
        })
        .sort({ roundNumber: 1, startDateTime: 1 }),
    });
  },
  result: async (req, res) => {
    const match = await mongoose.connection.transaction(async (session) => {
      const settings = await lockRatings(session);
      const current = await Match.findById(req.params.id).session(session);
      ensure(current, "Match not found", 404);
      const event = await lockEvent(current.eventId, session, true);
      ensure(
        ["scheduled", "finalized"].includes(current.matchStatus) &&
          current.teamA &&
          current.teamB,
        "Match is not ready",
      );
      const side = scoreMatch(req.body.scores, event);
      const before = current.toObject();
      const sameScores =
        JSON.stringify(current.scores.map((g) => ({ a: g.a, b: g.b }))) ===
        JSON.stringify(req.body.scores);
      const rated =
        req.body.rated ?? (current.stage === "queue" ? true : current.rated);
      if (current.stage === "queue" && rated && !event.rated) {
        event.rated = true;
        await event.save({ session });
      }
      if (req.rankingAction === "correct")
        ensure(
          current.matchStatus === "finalized",
          "Only finalized matches can be corrected",
          409,
        );
      if (
        req.rankingAction === "finalize" &&
        current.matchStatus === "finalized"
      )
        ensure(
          sameScores,
          "Use the correction workflow for finalized results",
          409,
        );
      if (
        sameScores &&
        current.matchStatus === "finalized" &&
        rated === current.rated &&
        !(
          req.body.rated === true &&
          ((!current.ratingPolicy && settings.rating.enabled) ||
            !current.starPolicy)
        )
      )
        return current;
      ensure(
        current.revision === req.body.revision,
        "This result changed. Reload before saving.",
        409,
      );
      if (
        current.matchStatus === "finalized" &&
        current.bracketKey &&
        !sameScores
      ) {
        const previousBracket = await Match.find({ eventId: event._id })
          .session(session)
          .lean();
        await invalidateDescendants(
          current,
          session,
          req.body.cascadeCorrection,
        );
        await audit(
          req.user._id,
          "invalidate-advancement",
          "Event",
          event._id,
          previousBracket,
          { correctedMatch: current._id },
          session,
        );
        const roster = await participants(event._id, session);
        await notify(
          roster.map((p) => p._id),
          "Bracket corrected",
          `${event.eventName}: downstream assignments and results may have changed.`,
          "advancement",
          session,
        );
      }
      current.scores = req.body.scores;
      current.winner = side === "A" ? current.teamA : current.teamB;
      current.matchStatus = "finalized";
      current.completedAt ||= new Date();
      current.rated = rated;
      captureRatingPolicy(current, settings);
      await captureStarPolicy(current, session);
      current.finalizedBy = req.user._id;
      current.revision++;
      await current.save({ session });
      if (event.eventType === "tournament") {
        await advanceBracket(event, session);
        const team = await Team.findById(current.winner).session(session);
        await notify(
          team.players,
          "Tournament advancement",
          `${event.eventName}: check the bracket for your next match.`,
          "advancement",
          session,
        );
      }
      await rebuildRatings(session);
      await rebuildStarRankings(session, { actorId: req.user._id });
      const teams = await Team.find({
        _id: { $in: [current.teamA, current.teamB] },
      }).session(session);
      await notify(
        teams.flatMap((t) => t.players),
        "Match result finalized",
        `${event.eventName} · Round ${current.roundNumber}`,
        "result",
        session,
      );
      await audit(
        req.user._id,
        "finalize-result",
        "Match",
        current._id,
        before,
        { ...current.toObject(), correctionReason: req.body.reason },
        session,
      );
      return current;
    });
    publish();
    await publishRankingResult(match._id);
    res.json({ match });
  },
  enableRankings: async (req, res) => {
    await mongoose.connection.transaction(async (session) => {
      const settings = await lockRatings(session);
      const event = await lockEvent(req.params.id, session, true);
      event.rated = true;
      await event.save({ session });
      const matches = await Match.find({
        eventId: event._id,
        matchStatus: { $in: ["pending", "scheduled", "finalized"] },
      }).session(session);
      for (const match of matches) {
        const changed =
          !match.rated ||
          (match.matchStatus === "finalized" && !match.starPolicy);
        match.rated = true;
        if (match.matchStatus === "finalized") {
          captureRatingPolicy(match, settings);
          await captureStarPolicy(match, session);
        }
        if (changed) match.revision++;
        await match.save({ session });
      }
      await rebuildRatings(session);
      await rebuildStarRankings(session, { actorId: req.user._id });
      await audit(
        req.user._id,
        "enable-event-rankings",
        "Event",
        event._id,
        null,
        { matches: matches.length },
        session,
      );
    });
    publish();
    res.json({
      message: "Rankings applied to existing results and future games",
    });
  },
  setRated: async (req, res) => {
    await mongoose.connection.transaction(async (session) => {
      const settings = await lockRatings(session);
      const match = await Match.findById(req.params.id).session(session);
      ensure(match, "Match not found", 404);
      await lockEvent(match.eventId, session, true);
      ensure(
        ["scheduled", "finalized"].includes(match.matchStatus),
        "This match cannot be marked as rated",
      );
      if (
        match.rated === req.body.rated &&
        (!match.rated ||
          (match.starPolicy &&
            (!settings.rating.enabled || match.ratingPolicy)) ||
          match.matchStatus !== "finalized")
      )
        return;
      ensure(
        match.revision === req.body.revision,
        "This match changed. Reload before saving.",
        409,
      );
      const before = match.toObject();
      match.rated = req.body.rated;
      if (match.matchStatus === "finalized")
        captureRatingPolicy(match, settings);
      else if (!match.rated) match.ratingPolicy = undefined;
      if (match.matchStatus === "finalized")
        await captureStarPolicy(match, session);
      match.revision++;
      await match.save({ session });
      await rebuildRatings(session);
      await rebuildStarRankings(session, { actorId: req.user._id });
      await audit(
        req.user._id,
        "set-match-rated",
        "Match",
        match._id,
        before,
        { rated: match.rated, reason: req.body.reason },
        session,
      );
    });
    publish();
    res.json({
      message:
        "Match rating eligibility updated; subsequent ratings recalculated",
    });
  },
  invalidateResult: async (req, res) => {
    await mongoose.connection.transaction(async (session) => {
      await lockRatings(session);
      const match = await Match.findById(req.params.id).session(session);
      ensure(match, "Match not found", 404);
      ensure(
        match.stage !== "queue",
        "Use score correction for live queue results; completed players may already be in another game",
        409,
      );
      const event = await lockEvent(match.eventId, session, true);
      ensure(
        match.matchStatus === "finalized",
        "Only finalized results can be invalidated",
      );
      ensure(
        match.revision === req.body.revision,
        "This match changed. Reload before saving.",
        409,
      );
      const before = await Match.find({ eventId: event._id })
        .session(session)
        .lean();
      if (match.bracketKey)
        await invalidateDescendants(match, session, req.body.cascadeCorrection);
      match.scores = [];
      match.winner = undefined;
      match.completedAt = undefined;
      match.matchStatus = "scheduled";
      match.revision++;
      await match.save({ session });
      if (event.eventType === "tournament")
        await advanceBracket(event, session);
      await rebuildRatings(session);
      await rebuildStarRankings(session, { actorId: req.user._id });
      await audit(
        req.user._id,
        "invalidate-result",
        "Match",
        match._id,
        before,
        { reason: req.body.reason },
        session,
      );
      await notify(
        (await participants(event._id, session)).map((p) => p._id),
        "Match result invalidated",
        `${event.eventName}: results and ratings were recalculated.`,
        "result",
        session,
      );
    });
    publish();
    res.json({
      message:
        "Result invalidated; statistics, bracket and ratings recalculated",
    });
  },
  reschedule: async (req, res) => {
    await mongoose.connection.transaction(async (session) => {
      const match = await Match.findById(req.params.id).session(session);
      ensure(match, "Match not found", 404);
      ensure(
        match.stage !== "queue",
        "Live queue courts are assigned with Call Players",
        409,
      );
      const event = await lockEvent(match.eventId, session);
      ensure(
        match.matchStatus === "scheduled",
        "Only unplayed matches may be rescheduled",
      );
      const start = +req.body.startDateTime,
        duration = event.matchDuration * 60_000;
      ensure(
        event.courts.includes(req.body.courtNumber),
        "Select an event court",
      );
      ensure(
        start >= +event.startDateTime && start + duration <= +event.endDateTime,
        "Match must fit inside the event window",
      );
      const all = await Match.find({
        eventId: event._id,
        _id: { $ne: match._id },
      }).session(session);
      const conflicts = all.filter(
        (m) =>
          m.startDateTime &&
          +m.startDateTime < start + duration &&
          +m.startDateTime + duration > start,
      );
      ensure(
        !conflicts.some(
          (m) =>
            m.courtNumber === req.body.courtNumber ||
            [m.teamA, m.teamB].some((id) =>
              [String(match.teamA), String(match.teamB)].includes(String(id)),
            ),
        ),
        "Court or players already have an overlapping match",
        409,
      );
      const parents = all.filter(
        (m) =>
          match.sources.some(
            (s) =>
              ["W", "L"].includes(s.split(":")[0]) &&
              s.slice(2) === m.bracketKey,
          ) ||
          (match.bracketKey?.startsWith("K") && m.stage?.startsWith("group-")),
      );
      ensure(
        parents.every(
          (m) => !m.startDateTime || start >= +m.startDateTime + duration,
        ),
        "Match cannot start before its prerequisite matches finish",
      );
      const before = match.toObject();
      match.startDateTime = req.body.startDateTime;
      match.courtNumber = req.body.courtNumber;
      match.revision++;
      await match.save({ session });
      await audit(
        req.user._id,
        "reschedule-match",
        "Match",
        match._id,
        before,
        req.body,
        session,
      );
      const teams = await Team.find({
        _id: { $in: [match.teamA, match.teamB] },
      }).session(session);
      await notify(
        teams.flatMap((t) => t.players),
        "Match schedule changed",
        `${event.eventName}: check your new court and start time.`,
        "schedule",
        session,
      );
    });
    publish();
    res.json({ message: "Match rescheduled" });
  },
  reopenTeams: async (req, res) => {
    await mongoose.connection.transaction(async (session) => {
      const event = await lockEvent(req.params.id, session);
      ensure(req.body.confirm === true, "Confirmation required");
      ensure(
        !(await Match.exists({
          eventId: event._id,
          matchStatus: "finalized",
        }).session(session)),
        "Official results exist. Teams cannot be replaced after play.",
      );
      const before = (
        await Team.find({ eventId: event._id }).session(session)
      ).map((t) => t.toObject());
      await Match.deleteMany({ eventId: event._id }, { session });
      await Tournament.deleteOne({ eventId: event._id }, { session });
      await Team.deleteMany(
        {
          eventId: event._id,
          generationBatchId: { $ne: event.finalizedBatch },
        },
        { session },
      );
      await Team.updateMany(
        { eventId: event._id },
        { assignmentStatus: "draft" },
        { session },
      );
      event.finalizedBatch = undefined;
      await event.save({ session });
      await audit(
        req.user._id,
        "reopen-teams",
        "Event",
        event._id,
        before,
        { scheduleCleared: true },
        session,
      );
      await notify(
        (await participants(event._id, session)).map((p) => p._id),
        "Team assignments under review",
        `${event.eventName}: your club is updating teams and schedules.`,
        "teams",
        session,
      );
    });
    publish();
    res.json({ message: "Teams reopened as a draft; schedule cleared" });
  },
  partnerOptions: async (req, res) => {
    const event = await getEvent(req.params.id);
    ensure(
      event.teamMode === "player-selected",
      "This event does not accept partner requests",
    );
    const roster = await participants(event._id, null);
    ensure(
      ["admin", "super-admin"].includes(req.user.role) ||
        roster.some((p) => String(p._id) === String(req.user._id)),
      "Register for the event first",
      403,
    );
    const proposals = await TeamProposal.find({
      eventId: event._id,
      ...(["admin", "super-admin"].includes(req.user.role)
        ? {}
        : { requestedBy: req.user._id }),
    })
      .populate("requestedBy partnerId", "fullName")
      .lean();
    res.json({
      players: roster.map((p) => ({
        _id: p._id,
        fullName: p.fullName,
        ranking: p.officialRanking || p.provisionalRanking,
      })),
      proposals,
    });
  },
  requestPartner: async (req, res) => {
    await mongoose.connection.transaction(async (session) => {
      const event = await lockEvent(req.params.id, session);
      ensure(
        !event.finalizedBatch && event.teamMode === "player-selected",
        "Partner requests are closed",
      );
      const roster = await participants(event._id, session);
      const ids = [String(req.user._id), req.body.partnerId];
      ensure(
        ids[0] !== ids[1] &&
          ids.every((id) => roster.some((p) => String(p._id) === id)),
        "Choose another confirmed participant",
      );
      await TeamProposal.findOneAndUpdate(
        { eventId: event._id, requestedBy: req.user._id },
        {
          partnerId: req.body.partnerId,
          status: "pending",
          $unset: { reviewedBy: 1 },
        },
        { upsert: true, session },
      );
    });
    res.json({ message: "Partner request sent for administrator review" });
  },
  reviewPartner: async (req, res) => {
    await mongoose.connection.transaction(async (session) => {
      const event = await lockEvent(req.params.id, session);
      ensure(!event.finalizedBatch, "Teams are finalized");
      const proposal = await TeamProposal.findOne({
        _id: req.params.proposalId,
        eventId: event._id,
        status: "pending",
      }).session(session);
      ensure(proposal, "Pending request not found", 404);
      if (req.body.approve) {
        const roster = await participants(event._id, session);
        const ids = [proposal.requestedBy, proposal.partnerId];
        ensure(
          ids.every((id) => roster.some((p) => String(p._id) === String(id))),
          "Both players must still be confirmed",
        );
        const batch = event.activeBatch || randomUUID();
        ensure(
          !(await Team.exists({
            eventId: event._id,
            generationBatchId: batch,
            players: { $in: ids },
          }).session(session)),
          "One of these players is already assigned. Adjust draft teams first.",
        );
        await Team.create(
          [
            {
              eventId: event._id,
              generationBatchId: batch,
              players: ids,
              combinedRanking: ids.reduce((n, id) => {
                const p = roster.find((p) => String(p._id) === String(id));
                return n + (p.officialRanking || p.provisionalRanking);
              }, 0),
              combinedRating: ids.reduce(
                (n, id) =>
                  n +
                  numericalRating(
                    roster.find((p) => String(p._id) === String(id)),
                  ),
                0,
              ),
            },
          ],
          { session },
        );
        event.activeBatch = batch;
        await event.save({ session });
      }
      proposal.status = req.body.approve ? "approved" : "rejected";
      proposal.reviewedBy = req.user._id;
      await proposal.save({ session });
      await audit(
        req.user._id,
        "review-partner",
        "TeamProposal",
        proposal._id,
        null,
        { status: proposal.status },
        session,
      );
      await notify(
        [proposal.requestedBy, proposal.partnerId],
        "Partner request reviewed",
        `${event.eventName}: ${proposal.status}.`,
        "teams",
        session,
      );
    });
    publish();
    res.json({ message: "Partner request reviewed" });
  },
  bracket: async (req, res) =>
    res.json({
      tournament: await Tournament.findOne({ eventId: req.params.id }).populate(
        { path: "champion", populate: { path: "players", select: "fullName" } },
      ),
    }),
};
