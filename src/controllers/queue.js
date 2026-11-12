import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import { Event, EventRegistration, Team, Match } from "../models/index.js";
import { ensure } from "../middleware/security.js";
import { generateTeams } from "../services/teams.js";
import { audit, publish } from "../services/notifications.js";

async function eventFor(id, session, write = false) {
  const event = write
    ? await Event.findByIdAndUpdate(
        id,
        { $inc: { revision: 1 } },
        { returnDocument: "after", session },
      )
    : await Event.findById(id).session(session);
  ensure(event, "Event not found", 404);
  ensure(
    event.eventType === "open-play" && event.format === "random",
    "Live queue requires random open play",
  );
  if (write)
    ensure(
      !["draft", "completed", "cancelled"].includes(event.status),
      "Event is not open for queue play",
    );
  ensure(
    !(await Match.exists({ eventId: id, stage: { $ne: "queue" } }).session(
      session,
    )),
    "This event already has a fixed schedule. Create a new random queue event.",
    409,
  );
  return event;
}
async function snapshot(event, session) {
  const rows = await EventRegistration.find({
    eventId: event._id,
    registrationStatus: "confirmed",
  })
    .populate(
      "userId",
      "fullName officialRanking provisionalRanking doublesRating",
    )
    .sort({ registeredAt: 1, _id: 1 })
    .session(session);
  const matches = await Match.find({ eventId: event._id, stage: "queue" })
    .populate({
      path: "teamA teamB",
      populate: {
        path: "players",
        select: "fullName officialRanking provisionalRanking",
      },
    })
    .sort({ roundNumber: 1 })
    .session(session);
  const busy = new Set();
  const stats = new Map(
    rows.map((r) => [
      String(r.userId._id),
      {
        ...r.userId.toObject(),
        games: 0,
        wins: 0,
        lastResult: "N",
        waitingSince: r.registeredAt,
      },
    ]),
  );
  for (const m of matches)
    for (const t of [m.teamA, m.teamB])
      for (const p of t.players) {
        const key = String(p._id),
          s = stats.get(key);
        if (["pending", "scheduled"].includes(m.matchStatus)) busy.add(key);
        if (m.matchStatus === "finalized" && s) {
          s.games++;
          s.wins += Number(String(m.winner) === String(t._id));
          if (+m.completedAt >= +new Date(s.waitingSince)) {
            s.waitingSince = m.completedAt;
            s.lastResult = String(m.winner) === String(t._id) ? "W" : "L";
          }
        }
      }
  const waiting = [...stats.values()]
    .filter((p) => !busy.has(String(p._id)))
    .sort(
      (a, b) =>
        a.games - b.games ||
        +new Date(a.waitingSince) - +new Date(b.waitingSince) ||
        String(a._id).localeCompare(String(b._id)),
    );
  return {
    waiting,
    live: matches.filter((m) => m.matchStatus === "scheduled"),
    next: matches.filter((m) => m.matchStatus === "pending"),
    completed: matches.filter((m) => m.matchStatus === "finalized").length,
  };
}
export const queueController = {
  get: async (req, res) => {
    const event = await eventFor(req.params.id, null);
    res.json(await snapshot(event, null));
  },
  prepare: async (req, res) => {
    await mongoose.connection.transaction(async (session) => {
      const event = await eventFor(req.params.id, session, true);
      const data = await snapshot(event, session);
      ensure(data.next.length < event.courts.length, "Up Next is full", 409);
      ensure(
        data.waiting.length >= 4,
        "Four waiting players are required",
        409,
      );
      const draft = generateTeams(data.waiting.slice(0, 4), "random");
      const roundNumber =
        (await Match.countDocuments({ eventId: event._id }).session(session)) +
        1;
      const teams = await Team.insertMany(
        draft.teams.map((t) => ({
          ...t,
          eventId: event._id,
          generationBatchId: `queue-${randomUUID()}`,
          roundNumber,
          assignmentStatus: "finalized",
        })),
        { session },
      );
      const [match] = await Match.create(
        [
          {
            eventId: event._id,
            teamA: teams[0]._id,
            teamB: teams[1]._id,
            roundNumber,
            stage: "queue",
            matchStatus: "pending",
            rated: event.rated,
          },
        ],
        { session },
      );
      await audit(
        req.user._id,
        "queue-prepare",
        "Match",
        match._id,
        null,
        { players: draft.teams.flatMap((t) => t.players) },
        session,
      );
    });
    publish();
    res.json({ message: "Next match ready" });
  },
  start: async (req, res) => {
    await mongoose.connection.transaction(async (session) => {
      const event = await eventFor(req.params.id, session, true);
      ensure(event.courts.includes(req.body.court), "Unknown court");
      const match = await Match.findOne({
        _id: req.params.matchId,
        eventId: event._id,
        stage: "queue",
      }).session(session);
      ensure(
        match?.matchStatus === "pending",
        "Match is no longer waiting",
        409,
      );
      ensure(
        !(await Match.exists({
          eventId: event._id,
          courtNumber: req.body.court,
          matchStatus: "scheduled",
        }).session(session)),
        "Court is occupied",
        409,
      );
      match.courtNumber = req.body.court;
      match.startDateTime = new Date();
      match.matchStatus = "scheduled";
      await match.save({ session });
      await audit(
        req.user._id,
        "queue-start",
        "Match",
        match._id,
        null,
        { court: req.body.court },
        session,
      );
    });
    publish();
    res.json({ message: "Match started" });
  },
  cancel: async (req, res) => {
    await mongoose.connection.transaction(async (session) => {
      await eventFor(req.params.id, session, true);
      const match = await Match.findOne({
        _id: req.params.matchId,
        eventId: req.params.id,
        stage: "queue",
        matchStatus: "pending",
      }).session(session);
      ensure(match, "Only an Up Next match can be released", 409);
      await Team.deleteMany(
        { _id: { $in: [match.teamA, match.teamB] } },
        { session },
      );
      await Match.deleteOne({ _id: match._id }, { session });
      await audit(
        req.user._id,
        "queue-release",
        "Match",
        match._id,
        match.toObject(),
        null,
        session,
      );
    });
    publish();
    res.json({ message: "Players returned to queue" });
  },
};
