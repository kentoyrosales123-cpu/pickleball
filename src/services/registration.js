import mongoose from "mongoose";
import {
  Event,
  EventRegistration,
  User,
  Team,
  Match,
} from "../models/index.js";
import { ensure } from "../middleware/security.js";
import { notify, audit, publish } from "./notifications.js";
export async function registerPlayer(eventId, userId, actor, cancel = false) {
  const result = await mongoose.connection.transaction(async (session) => {
    // Every mutation writes the event document, serializing capacity, waitlist and roster changes.
    const event = await Event.findOneAndUpdate(
      { _id: eventId },
      { $inc: { revision: 1 } },
      { returnDocument: "after", session },
    );
    ensure(event, "Event not found", 404);
    const user = await User.findById(userId).session(session);
    ensure(user?.active, "Active player not found", 404);
    ensure(!event.finalizedBatch, "Roster is locked after teams are finalized");
    const existing = await EventRegistration.findOne({
      eventId,
      userId,
    }).session(session);
    const isAdmin = actor.role === "admin";
    const now = new Date();
    if (cancel) {
      const assigned = await Team.find({ eventId, players: userId })
        .distinct("_id")
        .session(session);
      ensure(
        !(await Match.exists({
          eventId,
          stage: "queue",
          matchStatus: { $in: ["pending", "scheduled"] },
          $or: [{ teamA: { $in: assigned } }, { teamB: { $in: assigned } }],
        }).session(session)),
        "Release the Up Next match or finish the live game before removing this player",
        409,
      );
      ensure(
        isAdmin || now < event.registrationDeadline,
        "Cancellation deadline has passed",
      );
      ensure(
        existing && existing.registrationStatus !== "cancelled",
        "Registration not found",
        404,
      );
      if (existing.registrationStatus === "confirmed") {
        event.confirmedCount--;
        const next = await EventRegistration.findOne({
          eventId,
          registrationStatus: "waitlisted",
        })
          .sort({ registeredAt: 1, _id: 1 })
          .session(session);
        if (next) {
          next.registrationStatus = "confirmed";
          next.waitlistPosition = undefined;
          await next.save({ session });
          event.confirmedCount++;
          await notify(
            [next.userId],
            "You are in!",
            `A slot opened in ${event.eventName}.`,
            "registration",
            session,
          );
        }
      }
      existing.registrationStatus = "cancelled";
      existing.waitlistPosition = undefined;
      await existing.save({ session });
    } else {
      ensure(
        ["registration-open"].includes(event.status) ||
          (isAdmin &&
            ["published", "registration-closed"].includes(event.status)),
        "Registration is not open",
      );
      ensure(
        isAdmin ||
          (now >= event.registrationOpen && now < event.registrationDeadline),
        "Outside registration window",
      );
      const rank = user.officialRanking || user.provisionalRanking;
      ensure(
        rank >= event.minRanking && rank <= event.maxRanking,
        "Player ranking is not eligible",
      );
      ensure(
        !existing || existing.registrationStatus === "cancelled",
        "Already registered",
        409,
      );
      const full = event.confirmedCount >= event.capacity;
      ensure(!full || event.waitlistEnabled, "Event is full", 409);
      const data = {
        registrationStatus: full ? "waitlisted" : "confirmed",
        registeredAt: now,
        waitlistPosition: full
          ? (await EventRegistration.countDocuments({
              eventId,
              registrationStatus: "waitlisted",
            }).session(session)) + 1
          : undefined,
      };
      await EventRegistration.findOneAndUpdate(
        { eventId, userId },
        { $set: data },
        { upsert: true, session },
      );
      if (!full) event.confirmedCount++;
      await notify(
        [userId],
        full ? "Added to waiting list" : "Registration confirmed",
        event.eventName,
        "registration",
        session,
      );
    }
    // Roster edits invalidate all draft assignments.
    await Team.deleteMany({ eventId, assignmentStatus: "draft" }, { session });
    event.activeBatch = undefined;
    await event.save({ session });
    const waiting = await EventRegistration.find({
      eventId,
      registrationStatus: "waitlisted",
    })
      .sort({ registeredAt: 1, _id: 1 })
      .session(session);
    if (waiting.length)
      await EventRegistration.bulkWrite(
        waiting.map((r, i) => ({
          updateOne: {
            filter: { _id: r._id },
            update: { $set: { waitlistPosition: i + 1 } },
          },
        })),
        { session },
      );
    if (isAdmin)
      await audit(
        actor._id,
        cancel ? "remove-participant" : "add-participant",
        "Event",
        eventId,
        null,
        { userId },
        session,
      );
    return EventRegistration.findOne({ eventId, userId }).session(session);
  });
  publish();
  return result;
}
