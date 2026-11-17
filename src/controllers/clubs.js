import mongoose from "mongoose";
import { z } from "zod";
import {
  Club,
  ClubMember,
  Event,
  EventRegistration,
  Match,
  User,
} from "../models/index.js";
import { ensure } from "../middleware/security.js";
import {
  audit,
  notify,
  publish,
  publishTo,
} from "../services/notifications.js";

const MAX_OWNED_CLUBS = 5;
const isAdmin = (user) => ["admin", "super-admin"].includes(user?.role);
const card =
  "fullName username profileImage officialRanking provisionalRanking";
const objectId = (value, message) => {
  ensure(/^[a-f\d]{24}$/i.test(value ?? ""), message, 404);
  return new mongoose.Types.ObjectId(value);
};
const person = (u) =>
  u && {
    id: String(u._id),
    fullName: u.fullName,
    username: u.username,
    profileImage: u.profileImage,
    officialRanking: u.officialRanking,
    provisionalRanking: u.provisionalRanking,
  };

export const clubSchema = z.object({
  name: z.string().trim().min(3).max(80),
  description: z.string().trim().max(2000).default(""),
  location: z.string().trim().max(200).default(""),
  paymentInstructions: z.string().trim().max(500).default(""),
});
export const memberRoleSchema = z.object({ role: z.enum(["host", "member"]) });

const date = z.coerce.date();
export const meetupSchema = z
  .object({
    eventName: z.string().trim().min(3).max(120),
    description: z.string().max(3000).default(""),
    location: z.string().trim().min(2).max(200),
    startDateTime: date,
    endDateTime: date,
    // Defaults to the start time: players can join until play begins.
    registrationDeadline: date.optional(),
    capacity: z.coerce.number().int().min(4).max(256),
    minRanking: z.coerce.number().int().min(1).max(12).default(1),
    maxRanking: z.coerce.number().int().min(1).max(12).default(12),
    fee: z.coerce.number().min(0).max(100000).default(0),
    waitlistEnabled: z.boolean().default(true),
    courts: z
      .array(z.string().trim().min(1).max(30))
      .min(1)
      .max(30)
      .refine((v) => new Set(v).size === v.length, "Court names must be unique")
      .default(["1"]),
    format: z
      .enum(["random", "balanced", "round-robin", "rotating"])
      .default("random"),
  })
  .refine((v) => v.minRanking <= v.maxRanking, {
    message: "Minimum level exceeds maximum",
  })
  .refine((v) => v.startDateTime < v.endDateTime, {
    message: "The meetup must end after it starts",
  })
  .refine((v) => v.endDateTime - v.startDateTime <= 24 * 3600_000, {
    message: "A meetup can last at most 24 hours",
  })
  .refine(
    (v) => !v.registrationDeadline || v.registrationDeadline <= v.startDateTime,
    { message: "Registration must close by the start time" },
  );
export const attendanceSchema = z.object({
  attendance: z.enum(["pending", "present", "no-show"]),
});
export const paymentStatusSchema = z.object({
  paymentStatus: z.enum(["unpaid", "submitted", "paid", "waived"]),
});
export const paymentSubmitSchema = z.object({
  paymentMethod: z.enum(["gcash", "maya", "bank", "cash", "other"]),
  paymentReference: z.string().trim().max(100).default(""),
});

async function getClub(id, session) {
  const club = await Club.findById(objectId(id, "Club not found")).session(
    session || null,
  );
  ensure(club, "Club not found", 404);
  return club;
}
export async function clubRole(clubId, userId, session) {
  if (!clubId) return null;
  const m = await ClubMember.findOne({ clubId, userId }).session(
    session || null,
  );
  return m?.role || null;
}
const hosts = (role) => ["owner", "host"].includes(role);
// Admins manage every event; club owners and hosts manage their club's meetups.
export async function canManage(event, user, session) {
  if (isAdmin(user)) return true;
  return hosts(await clubRole(event.clubId, user._id, session));
}
async function requireHost(club, user, session) {
  const role = await clubRole(club._id, user._id, session);
  ensure(
    hosts(role) || isAdmin(user),
    "Only club owners and hosts can do that",
    403,
  );
  return role;
}
async function managedEvent(id, user, session) {
  const event = await Event.findById(objectId(id, "Event not found")).session(
    session || null,
  );
  ensure(event, "Event not found", 404);
  ensure(
    await canManage(event, user, session),
    "Only this meetup’s hosts can do that",
    403,
  );
  return event;
}
const clubView = (c, myRole = null) => ({
  id: String(c._id),
  name: c.name,
  description: c.description,
  location: c.location,
  paymentInstructions: c.paymentInstructions,
  memberCount: c.memberCount,
  owner: c.owner?._id ? person(c.owner) : String(c.owner),
  createdAt: c.createdAt,
  myRole,
});
const rosterView = (r) => ({
  id: String(r._id),
  player: person(r.userId),
  registrationStatus: r.registrationStatus,
  waitlistPosition: r.waitlistPosition,
  registeredAt: r.registeredAt,
  attendance: r.attendance || "pending",
  checkedInAt: r.checkedInAt,
  paymentStatus: r.paymentStatus || "unpaid",
  paymentMethod: r.paymentMethod,
  paymentReference: r.paymentReference,
  paymentSubmittedAt: r.paymentSubmittedAt,
  paidAt: r.paidAt,
});
// Mongoose throws on the duplicate nameKey; this gives a friendlier message.
async function saveClub(fn) {
  try {
    return await fn();
  } catch (error) {
    if (error.code === 11000 && error.keyPattern?.nameKey)
      ensure(false, "A club with that name already exists", 409);
    throw error;
  }
}
const meetupFields = (body) => ({
  eventName: body.eventName,
  description: body.description,
  location: body.location,
  startDateTime: body.startDateTime,
  endDateTime: body.endDateTime,
  registrationDeadline: body.registrationDeadline || body.startDateTime,
  capacity: body.capacity,
  minRanking: body.minRanking,
  maxRanking: body.maxRanking,
  fee: body.fee,
  waitlistEnabled: body.waitlistEnabled,
  courts: body.courts,
  format: body.format,
});

export const clubController = {
  list: async (req, res) => {
    const q = String(req.query.q ?? "").trim();
    ensure(q.length <= 60, "Search is too long.");
    const filter = q
      ? {
          name: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
        }
      : {};
    const [clubs, mine] = await Promise.all([
      Club.find(filter)
        .sort({ memberCount: -1, name: 1 })
        .limit(50)
        .populate("owner", card),
      ClubMember.find({ userId: req.user._id }).lean(),
    ]);
    const roles = new Map(mine.map((m) => [String(m.clubId), m.role]));
    // My clubs are always listed, even beyond the first 50 results.
    const missing = mine
      .map((m) => m.clubId)
      .filter((id) => !clubs.some((c) => String(c._id) === String(id)));
    const extra =
      !q && missing.length
        ? await Club.find({ _id: { $in: missing } }).populate("owner", card)
        : [];
    res.json({
      clubs: [...clubs, ...extra].map((c) =>
        clubView(c, roles.get(String(c._id)) || null),
      ),
    });
  },
  create: async (req, res) => {
    const owned = await Club.countDocuments({ owner: req.user._id });
    ensure(
      owned < MAX_OWNED_CLUBS,
      `You can own at most ${MAX_OWNED_CLUBS} clubs`,
      409,
    );
    const club = await saveClub(() =>
      mongoose.connection.transaction(async (session) => {
        const [club] = await Club.create(
          [
            {
              ...req.body,
              nameKey: req.body.name.toLowerCase(),
              owner: req.user._id,
              memberCount: 1,
            },
          ],
          { session },
        );
        await ClubMember.create(
          [{ clubId: club._id, userId: req.user._id, role: "owner" }],
          { session },
        );
        await audit(
          req.user._id,
          "create",
          "Club",
          club._id,
          null,
          req.body,
          session,
        );
        return club;
      }),
    );
    res.status(201).json({ club: clubView(club, "owner") });
  },
  detail: async (req, res) => {
    const club = await getClub(req.params.id);
    await club.populate("owner", card);
    const myRole = await clubRole(club._id, req.user._id);
    const manager = hosts(myRole) || isAdmin(req.user);
    const [members, meetups, mine] = await Promise.all([
      ClubMember.find({ clubId: club._id })
        .sort({ createdAt: 1 })
        .limit(500)
        .populate("userId", `${card} active`),
      Event.find({
        clubId: club._id,
        endDateTime: { $gte: new Date(Date.now() - 30 * 86400_000) },
        ...(manager ? {} : { status: { $ne: "draft" } }),
      })
        .sort({ startDateTime: 1 })
        .limit(100)
        .lean(),
      EventRegistration.find({ userId: req.user._id }).lean(),
    ]);
    const order = { owner: 0, host: 1, member: 2 };
    res.json({
      club: clubView(club, myRole),
      canManage: manager,
      members: members
        .filter((m) => m.userId?.active)
        .map((m) => ({
          ...person(m.userId),
          role: m.role,
          joinedAt: m.createdAt,
        }))
        .sort((a, b) => order[a.role] - order[b.role]),
      meetups: meetups.map((e) => ({
        ...e,
        registration: mine.find((r) => String(r.eventId) === String(e._id))
          ?.registrationStatus,
      })),
    });
  },
  update: async (req, res) => {
    const club = await getClub(req.params.id);
    ensure(
      String(club.owner) === String(req.user._id) || isAdmin(req.user),
      "Only the club owner can edit the club",
      403,
    );
    const before = club.toObject();
    Object.assign(club, req.body, { nameKey: req.body.name.toLowerCase() });
    await saveClub(() => club.save());
    await audit(req.user._id, "update", "Club", club._id, before, req.body);
    res.json({ club: clubView(club, await clubRole(club._id, req.user._id)) });
  },
  remove: async (req, res) => {
    await mongoose.connection.transaction(async (session) => {
      const club = await getClub(req.params.id, session);
      ensure(
        String(club.owner) === String(req.user._id) || isAdmin(req.user),
        "Only the club owner can delete the club",
        403,
      );
      ensure(
        !(await Event.exists({
          clubId: club._id,
          endDateTime: { $gte: new Date() },
          status: { $nin: ["cancelled", "completed"] },
        }).session(session)),
        "Cancel this club’s upcoming meetups before deleting it",
        409,
      );
      await ClubMember.deleteMany({ clubId: club._id }, { session });
      await Club.deleteOne({ _id: club._id }, { session });
      await audit(
        req.user._id,
        "delete",
        "Club",
        club._id,
        club.toObject(),
        null,
        session,
      );
    });
    res.json({ message: "Club deleted" });
  },
  join: async (req, res) => {
    const joined = await mongoose.connection.transaction(async (session) => {
      const club = await getClub(req.params.id, session);
      const existing = await ClubMember.findOne({
        clubId: club._id,
        userId: req.user._id,
      }).session(session);
      if (existing) return false;
      await ClubMember.create(
        [{ clubId: club._id, userId: req.user._id, role: "member" }],
        { session },
      );
      await Club.updateOne(
        { _id: club._id },
        { $inc: { memberCount: 1 } },
        { session },
      );
      return true;
    });
    res.json({
      message: joined
        ? "Welcome to the club! You’ll be notified of new meetups."
        : "You’re already a member.",
    });
  },
  leave: async (req, res) => {
    await mongoose.connection.transaction(async (session) => {
      const club = await getClub(req.params.id, session);
      ensure(
        String(club.owner) !== String(req.user._id),
        "Owners can’t leave their own club. Delete it instead.",
        409,
      );
      const { deletedCount } = await ClubMember.deleteOne(
        { clubId: club._id, userId: req.user._id },
        { session },
      );
      if (deletedCount)
        await Club.updateOne(
          { _id: club._id },
          { $inc: { memberCount: -1 } },
          { session },
        );
    });
    res.json({ message: "You left the club." });
  },
  setRole: async (req, res) => {
    const club = await getClub(req.params.id);
    ensure(
      String(club.owner) === String(req.user._id) || isAdmin(req.user),
      "Only the club owner can change roles",
      403,
    );
    const userId = objectId(req.params.userId, "Member not found");
    const member = await ClubMember.findOne({ clubId: club._id, userId });
    ensure(member, "Member not found", 404);
    ensure(member.role !== "owner", "The owner’s role can’t be changed", 409);
    member.role = req.body.role;
    await member.save();
    if (req.body.role === "host")
      await notify(
        [userId],
        "You’re now a club host",
        `You can post and run meetups for ${club.name}.`,
        "club",
      );
    await audit(req.user._id, "set-club-role", "Club", club._id, null, {
      userId,
      role: req.body.role,
    });
    publishTo([userId]);
    res.json({ message: "Role updated" });
  },
  removeMember: async (req, res) => {
    await mongoose.connection.transaction(async (session) => {
      const club = await getClub(req.params.id, session);
      const myRole = await requireHost(club, req.user, session);
      const userId = objectId(req.params.userId, "Member not found");
      const member = await ClubMember.findOne({
        clubId: club._id,
        userId,
      }).session(session);
      ensure(member, "Member not found", 404);
      ensure(member.role !== "owner", "The owner can’t be removed", 409);
      ensure(
        member.role === "member" || myRole === "owner" || isAdmin(req.user),
        "Only the owner can remove a host",
        403,
      );
      await member.deleteOne({ session });
      await Club.updateOne(
        { _id: club._id },
        { $inc: { memberCount: -1 } },
        { session },
      );
      await audit(
        req.user._id,
        "remove-club-member",
        "Club",
        club._id,
        { userId, role: member.role },
        null,
        session,
      );
    });
    res.json({ message: "Member removed" });
  },
  createMeetup: async (req, res) => {
    ensure(
      req.body.startDateTime > new Date(),
      "The meetup must start in the future",
    );
    const event = await mongoose.connection.transaction(async (session) => {
      const club = await getClub(req.params.id, session);
      await requireHost(club, req.user, session);
      const [event] = await Event.create(
        [
          {
            ...meetupFields(req.body),
            eventType: "open-play",
            registrationOpen: new Date(),
            status: "registration-open",
            teamMode: "balanced",
            targetPoints: 11,
            winningMargin: 2,
            bestOf: 1,
            matchDuration: 20,
            rounds: 3,
            clubId: club._id,
            createdBy: req.user._id,
          },
        ],
        { session },
      );
      const members = await ClubMember.find({
        clubId: club._id,
        userId: { $ne: req.user._id },
      })
        .distinct("userId")
        .session(session);
      await notify(
        members,
        `New meetup · ${club.name}`,
        `${event.eventName} on ${event.startDateTime.toDateString()}`,
        "event",
        session,
      );
      await audit(
        req.user._id,
        "create-meetup",
        "Event",
        event._id,
        null,
        req.body,
        session,
      );
      return event;
    });
    publish();
    res.status(201).json({ event });
  },
  updateMeetup: async (req, res) => {
    const event = await mongoose.connection.transaction(async (session) => {
      const event = await Event.findByIdAndUpdate(
        objectId(req.params.eventId, "Meetup not found"),
        { $inc: { revision: 1 } },
        { returnDocument: "after", session },
      );
      ensure(
        event?.clubId && String(event.clubId) === req.params.id,
        "Meetup not found",
        404,
      );
      ensure(
        await canManage(event, req.user, session),
        "Only this meetup’s hosts can do that",
        403,
      );
      ensure(
        !["cancelled", "completed"].includes(event.status),
        "This meetup is closed",
      );
      const next = meetupFields(req.body);
      ensure(
        next.capacity >= event.confirmedCount,
        "Capacity can’t be below the number of confirmed players",
      );
      const roster = await EventRegistration.find({
        eventId: event._id,
        registrationStatus: { $ne: "cancelled" },
      })
        .populate("userId", "officialRanking provisionalRanking")
        .session(session);
      ensure(
        roster.every((r) => {
          const level = r.userId.officialRanking || r.userId.provisionalRanking;
          return level >= next.minRanking && level <= next.maxRanking;
        }),
        "The new level range would exclude players who already joined",
      );
      if (await Match.exists({ eventId: event._id }).session(session))
        for (const key of ["startDateTime", "endDateTime", "courts", "format"])
          ensure(
            JSON.stringify(event[key]) === JSON.stringify(next[key]),
            `Can’t change ${key} after matches have been scheduled`,
          );
      const before = event.toObject();
      Object.assign(event, next);
      await event.save({ session });
      await notify(
        roster.map((r) => r.userId._id),
        "Meetup updated",
        event.eventName,
        "event",
        session,
      );
      await audit(
        req.user._id,
        "update-meetup",
        "Event",
        event._id,
        before,
        req.body,
        session,
      );
      return event;
    });
    publish();
    res.json({ event });
  },
  cancelMeetup: async (req, res) => {
    await mongoose.connection.transaction(async (session) => {
      const event = await Event.findByIdAndUpdate(
        objectId(req.params.eventId, "Meetup not found"),
        { $inc: { revision: 1 } },
        { returnDocument: "after", session },
      );
      ensure(
        event?.clubId && String(event.clubId) === req.params.id,
        "Meetup not found",
        404,
      );
      ensure(
        await canManage(event, req.user, session),
        "Only this meetup’s hosts can do that",
        403,
      );
      ensure(event.status !== "completed", "This meetup already finished");
      if (event.status === "cancelled") return;
      event.status = "cancelled";
      await event.save({ session });
      const players = await EventRegistration.find({
        eventId: event._id,
        registrationStatus: { $ne: "cancelled" },
      })
        .distinct("userId")
        .session(session);
      await notify(
        players,
        "Meetup cancelled",
        `${event.eventName} on ${event.startDateTime.toDateString()} was cancelled by the host.`,
        "event",
        session,
      );
      await audit(
        req.user._id,
        "cancel-meetup",
        "Event",
        event._id,
        null,
        null,
        session,
      );
    });
    publish();
    res.json({ message: "Meetup cancelled" });
  },
  // ---- Host tools on any event the user manages ----
  roster: async (req, res) => {
    const event = await managedEvent(req.params.id, req.user);
    const rows = await EventRegistration.find({ eventId: event._id })
      .populate("userId", card)
      .sort({ registeredAt: 1 });
    const live = rows.filter(
      (r) => r.userId && r.registrationStatus !== "cancelled",
    );
    const confirmed = live.filter((r) => r.registrationStatus === "confirmed");
    res.json({
      roster: live.map(rosterView),
      summary: {
        confirmed: confirmed.length,
        waitlisted: live.length - confirmed.length,
        present: confirmed.filter((r) => r.attendance === "present").length,
        noShow: confirmed.filter((r) => r.attendance === "no-show").length,
        paid: confirmed.filter((r) =>
          ["paid", "waived"].includes(r.paymentStatus),
        ).length,
        awaitingConfirmation: confirmed.filter(
          (r) => r.paymentStatus === "submitted",
        ).length,
        collected:
          event.fee *
          confirmed.filter((r) => r.paymentStatus === "paid").length,
      },
    });
  },
  setAttendance: async (req, res) => {
    const event = await managedEvent(req.params.id, req.user);
    const registration = await EventRegistration.findOne({
      eventId: event._id,
      userId: objectId(req.params.userId, "Player not found"),
      registrationStatus: "confirmed",
    });
    ensure(registration, "Confirmed player not found", 404);
    ensure(
      req.body.attendance === "pending" ||
        Date.now() >= +event.startDateTime - 2 * 3600_000,
      "Check-in opens 2 hours before the meetup starts",
    );
    const before = registration.attendance;
    registration.attendance = req.body.attendance;
    registration.checkedInAt =
      req.body.attendance === "present" ? new Date() : null;
    await registration.save();
    await audit(
      req.user._id,
      "set-attendance",
      "EventRegistration",
      registration._id,
      { attendance: before },
      { attendance: req.body.attendance },
    );
    publishTo([registration.userId]);
    res.json({ registration: rosterView(registration) });
  },
  setPayment: async (req, res) => {
    const event = await managedEvent(req.params.id, req.user);
    const registration = await EventRegistration.findOne({
      eventId: event._id,
      userId: objectId(req.params.userId, "Player not found"),
      registrationStatus: { $ne: "cancelled" },
    });
    ensure(registration, "Player not found on this meetup", 404);
    const before = registration.paymentStatus;
    const status = req.body.paymentStatus;
    registration.paymentStatus = status;
    registration.paidAt = status === "paid" ? new Date() : undefined;
    await registration.save();
    if (status === "paid" && before !== "paid")
      await notify(
        [registration.userId],
        "Payment confirmed",
        `Your fee for ${event.eventName} was received. See you on court!`,
        "payment",
      );
    else if (status === "unpaid" && before === "submitted")
      await notify(
        [registration.userId],
        "Payment not confirmed",
        `The host couldn’t confirm your payment for ${event.eventName}. Please check your reference and resubmit.`,
        "payment",
      );
    await audit(
      req.user._id,
      "set-payment",
      "EventRegistration",
      registration._id,
      { paymentStatus: before },
      { paymentStatus: status },
    );
    publishTo([registration.userId]);
    res.json({ registration: rosterView(registration) });
  },
  // A player reports how they paid; the host confirms it.
  submitPayment: async (req, res) => {
    const event = await Event.findById(
      objectId(req.params.id, "Event not found"),
    );
    ensure(event, "Event not found", 404);
    ensure(event.fee > 0, "This event is free");
    const registration = await EventRegistration.findOne({
      eventId: event._id,
      userId: req.user._id,
      registrationStatus: { $ne: "cancelled" },
    });
    ensure(registration, "Join the event before paying", 404);
    ensure(
      !["paid", "waived"].includes(registration.paymentStatus),
      "Your payment is already settled",
      409,
    );
    ensure(
      req.body.paymentMethod === "cash" || req.body.paymentReference,
      "Enter the reference number from your payment",
    );
    Object.assign(registration, {
      paymentStatus: "submitted",
      paymentMethod: req.body.paymentMethod,
      paymentReference: req.body.paymentReference || undefined,
      paymentSubmittedAt: new Date(),
    });
    await registration.save();
    const managers = event.clubId
      ? await ClubMember.find({
          clubId: event.clubId,
          role: { $in: ["owner", "host"] },
        }).distinct("userId")
      : await User.find({
          role: { $in: ["admin", "super-admin"] },
          active: true,
        }).distinct("_id");
    await notify(
      managers,
      "Payment to confirm",
      `${req.user.fullName} paid for ${event.eventName} via ${req.body.paymentMethod}${req.body.paymentReference ? ` (ref ${req.body.paymentReference})` : ""}.`,
      "payment",
    );
    publishTo(managers);
    res.json({
      registration: rosterView(registration),
      message: "Payment submitted. The host will confirm it.",
    });
  },
  // Events the player has joined, with attendance and payment — their history.
  myAttendance: async (req, res) => {
    const rows = await EventRegistration.find({
      userId: req.user._id,
      registrationStatus: "confirmed",
    })
      .populate(
        "eventId",
        "eventName startDateTime endDateTime location fee status clubId",
      )
      .lean();
    const past = rows
      .filter((r) => r.eventId && new Date(r.eventId.endDateTime) < new Date())
      .sort((a, b) => b.eventId.startDateTime - a.eventId.startDateTime);
    const counted = past.filter((r) => r.eventId.status !== "cancelled");
    res.json({
      summary: {
        attended: counted.filter((r) => r.attendance === "present").length,
        noShows: counted.filter((r) => r.attendance === "no-show").length,
        recorded: counted.filter((r) => r.attendance !== "pending").length,
      },
      history: past.slice(0, 100).map((r) => ({
        eventId: String(r.eventId._id),
        eventName: r.eventId.eventName,
        startDateTime: r.eventId.startDateTime,
        location: r.eventId.location,
        status: r.eventId.status,
        attendance: r.attendance || "pending",
        paymentStatus: r.eventId.fee ? r.paymentStatus || "unpaid" : null,
      })),
    });
  },
};
