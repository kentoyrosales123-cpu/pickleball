import mongoose from "mongoose";
import { z } from "zod";
import {
  SupportTicket,
  User,
  SUPPORT_CATEGORIES,
  SUPPORT_STATUSES,
} from "../models/index.js";
import { ensure } from "../middleware/security.js";
import { audit, notify, publishTo } from "../services/notifications.js";

const LABELS = {
  scam: "Scam or fraud",
  bug: "Bug or error",
  account: "Account problem",
  other: "Other",
};
export const ticketSchema = z.object({
  category: z.enum(SUPPORT_CATEGORIES),
  subject: z.string().trim().min(5).max(120),
  message: z.string().trim().min(10).max(4000),
  page: z.string().trim().max(200).optional(),
});
export const ticketUpdateSchema = z.object({
  status: z.enum(SUPPORT_STATUSES),
  adminReply: z.string().trim().max(2000).optional(),
});
const reporter = "fullName username email profileImage";

export const supportController = {
  create: async (req, res) => {
    let ticket,
      recipients = [];
    await mongoose.connection.transaction(async (session) => {
      [ticket] = await SupportTicket.create(
        [{ ...req.body, userId: req.user._id }],
        { session },
      );
      const staff = await User.find(
        { role: { $in: ["admin", "super-admin"] }, active: true },
        "_id",
        { session },
      );
      recipients = staff
        .map((u) => u._id)
        .filter((id) => String(id) !== String(req.user._id));
      await notify(
        recipients,
        `New support report: ${LABELS[ticket.category]}`,
        `${req.user.fullName}: ${ticket.subject}`,
        "support",
        session,
      );
      await audit(
        req.user._id,
        "support.create",
        "SupportTicket",
        ticket._id,
        null,
        { category: ticket.category, subject: ticket.subject },
        session,
      );
    });
    publishTo(recipients);
    res.status(201).json({
      ticket,
      message:
        ticket.category === "scam"
          ? "Thank you. A club administrator will review this report urgently."
          : "Thank you. Your report has been sent to the club administrators.",
    });
  },
  mine: async (req, res) =>
    res.json({
      tickets: await SupportTicket.find({ userId: req.user._id })
        .sort({ createdAt: -1 })
        .limit(50),
    }),
  list: async (req, res) => {
    const filter = SUPPORT_STATUSES.includes(req.query.status)
      ? { status: req.query.status }
      : {};
    if (SUPPORT_CATEGORIES.includes(req.query.category))
      filter.category = req.query.category;
    const [tickets, counts] = await Promise.all([
      SupportTicket.find(filter)
        .sort({ createdAt: -1 })
        .limit(200)
        .populate("userId", reporter)
        .populate("handledBy", "fullName"),
      SupportTicket.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
    ]);
    res.json({
      tickets,
      counts: Object.fromEntries(counts.map((c) => [c._id, c.count])),
    });
  },
  update: async (req, res) => {
    ensure(
      /^[a-f\d]{24}$/i.test(req.params.id),
      "Support report not found",
      404,
    );
    let ticket;
    await mongoose.connection.transaction(async (session) => {
      ticket = await SupportTicket.findById(req.params.id).session(session);
      ensure(ticket, "Support report not found", 404);
      const previous = {
        status: ticket.status,
        adminReply: ticket.adminReply,
      };
      ticket.status = req.body.status;
      if (req.body.adminReply !== undefined)
        ticket.adminReply = req.body.adminReply;
      ticket.handledBy = req.user._id;
      ticket.resolvedAt = ticket.status === "resolved" ? new Date() : undefined;
      await ticket.save({ session });
      const statusText = {
        open: "reopened",
        "in-progress": "being reviewed",
        resolved: "resolved",
      }[ticket.status];
      await notify(
        [ticket.userId],
        `Support report ${statusText}`,
        `"${ticket.subject}" is ${statusText}.${ticket.adminReply ? ` Reply: ${ticket.adminReply}` : ""}`,
        "support",
        session,
      );
      await audit(
        req.user._id,
        "support.update",
        "SupportTicket",
        ticket._id,
        previous,
        { status: ticket.status, adminReply: ticket.adminReply },
        session,
      );
    });
    publishTo([ticket.userId]);
    await ticket.populate([
      { path: "userId", select: reporter },
      { path: "handledBy", select: "fullName" },
    ]);
    res.json({ ticket });
  },
};
