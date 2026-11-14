import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import {
  Event,
  EventRegistration,
  Team,
  Match,
  User,
  Settings,
} from "../models/index.js";
import { RankingHistory } from "../models/ranking.js";
import { ensure } from "../middleware/security.js";
import { generateQueueTeams } from "../services/queue-matchmaking.js";
import { audit, publish, notify } from "../services/notifications.js";

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
async function snapshot(event, session, includeHistory = false) {
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
        queueStatus: r.queueStatus,
        waitingSince: r.queueReadyAt,
        lastPlayedAt: null,
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
          }
          if (+m.completedAt >= +new Date(s.lastPlayedAt)) {
            s.lastPlayedAt = m.completedAt;
            s.lastResult = String(m.winner) === String(t._id) ? "W" : "L";
          }
        }
      }
  const waiting = [...stats.values()]
    .filter((p) => p.queueStatus === "ready" && !busy.has(String(p._id)))
    .sort(
      (a, b) =>
        +new Date(a.waitingSince) - +new Date(b.waitingSince) ||
        a.games - b.games ||
        String(a._id).localeCompare(String(b._id)),
    );
  return {
    ...(includeHistory
      ? { history: matches, players: [...stats.values()] }
      : {}),
    waiting,
    unavailable: [...stats.values()].filter(
      (p) => p.queueStatus !== "ready" && !busy.has(String(p._id)),
    ),
    live: matches.filter((m) => m.matchStatus === "scheduled"),
    next: matches.filter((m) => m.matchStatus === "pending"),
    completed: matches.filter((m) => m.matchStatus === "finalized").length,
  };
}
export const queueController = {
  mine: async (req, res) => {
    const showRatingChanges =
      ["admin", "super-admin"].includes(req.user.role) ||
      Boolean(
        (await Settings.findOne({ key: "global" }).lean())?.showRankingMMR,
      );
    const registrations = await EventRegistration.find({
      userId: req.user._id,
      registrationStatus: "confirmed",
    })
      .select("eventId")
      .lean();
    const events = await Event.find({
      _id: { $in: registrations.map((r) => r.eventId) },
      eventType: "open-play",
      format: "random",
      status: {
        $nin:
          req.query.includeCompleted === "true"
            ? ["draft", "cancelled"]
            : ["draft", "completed", "cancelled"],
      },
    }).sort({ startDateTime: 1 });
    const sessions = [];
    for (const event of events) {
      if (await Match.exists({ eventId: event._id, stage: { $ne: "queue" } }))
        continue;
      const data = await snapshot(event, null, true);
      const me = data.players.find(
        (p) => String(p._id) === String(req.user._id),
      );
      if (!me) continue;
      const match = [...data.live, ...data.next].find((m) =>
        [...m.teamA.players, ...m.teamB.players].some(
          (p) => String(p._id) === String(req.user._id),
        ),
      );
      const position = data.waiting.findIndex(
        (p) => String(p._id) === String(req.user._id),
      );
      const ownTeam =
        match &&
        [match.teamA, match.teamB].find((t) =>
          t.players.some((p) => String(p._id) === String(req.user._id)),
        );
      const person = (p) => ({ _id: p._id, fullName: p.fullName });
      const finished = data.history
        .filter(
          (m) =>
            m.matchStatus === "finalized" &&
            [...m.teamA.players, ...m.teamB.players].some(
              (p) => String(p._id) === String(req.user._id),
            ),
        )
        .sort(
          (a, b) =>
            +b.completedAt - +a.completedAt || b.roundNumber - a.roundNumber,
        );
      const ids = finished.map((m) => m._id);
      const stars = await RankingHistory.find({
        playerId: req.user._id,
        matchId: { $in: ids },
        kind: "match",
      })
        .select("matchId starsChanged mmrChanged")
        .lean();
      const ratingByMatch = new Map(
        stars.map((r) => [String(r.matchId), r.mmrChanged]),
      );
      const starsByMatch = new Map(
        stars.map((r) => [String(r.matchId), r.starsChanged]),
      );
      const history = finished.map((m) => {
        const isA = m.teamA.players.some(
          (p) => String(p._id) === String(req.user._id),
        );
        const own = isA ? m.teamA : m.teamB;
        return {
          _id: m._id,
          revision: m.revision,
          round: m.roundNumber,
          completedAt: m.completedAt,
          court: m.courtNumber || null,
          won: String(m.winner) === String(own._id),
          scores: m.scores.map((s) => ({
            own: isA ? s.a : s.b,
            opponent: isA ? s.b : s.a,
          })),
          partner: person(
            own.players.find((p) => String(p._id) !== String(req.user._id)),
          ),
          opponents: (isA ? m.teamB : m.teamA).players.map(person),
          ratingChange: showRatingChanges
            ? (ratingByMatch.get(String(m._id)) ?? null)
            : null,
          ratingHidden: !showRatingChanges,
          starsChange: starsByMatch.get(String(m._id)) ?? null,
          reported: m.scoreReports.some(
            (r) =>
              String(r.playerId) === String(req.user._id) &&
              r.revision === m.revision,
          ),
        };
      });
      sessions.push({
        event: {
          _id: event._id,
          eventName: event.eventName,
          location: event.location,
          startDateTime: event.startDateTime,
          status: event.status,
        },
        status:
          event.status === "completed"
            ? "completed"
            : match
              ? match.matchStatus === "scheduled"
                ? "playing"
                : "up-next"
              : position >= 0
                ? "waiting"
                : me.queueStatus,
        queuePosition:
          event.status !== "completed" && position >= 0 ? position + 1 : null,
        waitingCount: event.status === "completed" ? 0 : data.waiting.length,
        waitingSince:
          event.status !== "completed" && position >= 0
            ? me.waitingSince
            : null,
        games: me.games,
        wins: me.wins,
        losses: me.games - me.wins,
        history,
        match: match
          ? {
              _id: match._id,
              court: match.courtNumber || null,
              partner: person(
                ownTeam.players.find(
                  (p) => String(p._id) !== String(req.user._id),
                ),
              ),
              opponents: (String(ownTeam._id) === String(match.teamA._id)
                ? match.teamB
                : match.teamA
              ).players.map(person),
            }
          : null,
      });
    }
    res.json({ sessions });
  },
  setOwnStatus: async (req, res) => {
    req.params.userId = String(req.user._id);
    return queueController.setStatus(req, res);
  },
  reportScore: async (req, res) => {
    await mongoose.connection.transaction(async (session) => {
      const event = await eventFor(req.params.id, session);
      const match = await Match.findOne({
        _id: req.params.matchId,
        eventId: event._id,
        stage: "queue",
        matchStatus: "finalized",
      })
        .populate("teamA teamB")
        .session(session);
      ensure(match, "Completed queue match not found", 404);
      ensure(
        [...match.teamA.players, ...match.teamB.players].some(
          (p) => String(p) === String(req.user._id),
        ),
        "Only players in this match can report its score",
        403,
      );
      ensure(
        match.revision === req.body.revision,
        "The score has changed. Refresh and review the latest result.",
        409,
      );
      const report = {
        playerId: req.user._id,
        revision: match.revision,
        reason: req.body.reason,
        reportedAt: new Date(),
      };
      const saved = await Match.updateOne(
        {
          _id: match._id,
          revision: match.revision,
          matchStatus: "finalized",
          scoreReports: {
            $not: {
              $elemMatch: { playerId: req.user._id, revision: match.revision },
            },
          },
        },
        { $push: { scoreReports: report } },
        { session },
      );
      ensure(
        saved.modifiedCount === 1,
        "This result has already been reported or changed. Refresh to check its status.",
        409,
      );
      const organizers = await User.find({
        active: true,
        role: { $in: ["admin", "super-admin"] },
      })
        .select("_id")
        .session(session);
      await notify(
        organizers.map((u) => u._id),
        "Score review requested",
        `${event.eventName}, match ${match.roundNumber}, Court ${match.courtNumber || "unassigned"}: ${req.user.fullName} reported an incorrect score. Recorded scores (Team A–Team B): ${match.scores.map((s) => `${s.a}–${s.b}`).join(", ")}. Reason: ${req.body.reason}. Review this match in the event's Matches tab.`,
        "score-report",
        session,
      );
      await audit(
        req.user._id,
        "queue-score-report",
        "Match",
        match._id,
        null,
        report,
        session,
      );
    });
    publish();
    res.json({ message: "Score report sent to the organizers" });
  },
  setStatus: async (req, res) => {
    ensure(
      ["admin", "super-admin"].includes(req.user.role) ||
        String(req.params.userId) === String(req.user._id),
      "You can only update your own availability",
      403,
    );
    await mongoose.connection.transaction(async (session) => {
      const event = await eventFor(req.params.id, session, true);
      const registration = await EventRegistration.findOne({
        eventId: event._id,
        userId: req.params.userId,
        registrationStatus: "confirmed",
      }).session(session);
      ensure(registration, "Confirmed player not found", 404);
      const assigned = await Team.find({
        eventId: event._id,
        players: req.params.userId,
      })
        .distinct("_id")
        .session(session);
      ensure(
        !(await Match.exists({
          eventId: event._id,
          stage: "queue",
          matchStatus: { $in: ["pending", "scheduled"] },
          $or: [{ teamA: { $in: assigned } }, { teamB: { $in: assigned } }],
        }).session(session)),
        "Return the Up Next match to the queue or finish the live game first",
        409,
      );
      const previous = registration.queueStatus;
      const next = req.body.status;
      if (previous === next) return;
      ensure(
        next !== "break" || previous === "ready",
        "Only ready players can take a break",
        409,
      );
      registration.queueStatus = next;
      registration.queueReadyAt = next === "ready" ? new Date() : null;
      await registration.save({ session });
      await audit(
        req.user._id,
        "queue-player-status",
        "EventRegistration",
        registration._id,
        { queueStatus: previous },
        { queueStatus: next },
        session,
      );
    });
    publish();
    res.json({ message: "Player availability updated" });
  },
  get: async (req, res) => {
    const event = await eventFor(req.params.id, null);
    res.json(await snapshot(event, null));
  },
  prepare: async (req, res) => {
    await mongoose.connection.transaction(async (session) => {
      const event = await eventFor(req.params.id, session, true);
      const data = await snapshot(event, session, true);
      ensure(data.next.length < event.courts.length, "Up Next is full", 409);
      ensure(
        data.waiting.length >= 4,
        "Four waiting players are required",
        409,
      );
      event.rated = true;
      await event.save({ session });
      const draft = generateQueueTeams(data.waiting.slice(0, 4), data.history);
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
            rated: true,
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
      const teams = await Team.find({
        _id: { $in: [match.teamA, match.teamB] },
      }).session(session);
      await notify(
        teams.flatMap((t) => t.players),
        `You are called to Court ${req.body.court}`,
        `${event.eventName}: your match is ready. Please go to Court ${req.body.court}.`,
        "court-call",
        session,
        {
          eventId: event._id,
          matchId: match._id,
          emailState: "pending",
          expiresAt: new Date(Date.now() + 5 * 60_000),
        },
      );
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
