import nodemailer from "nodemailer";
import {
  Event,
  EventRegistration,
  Match,
  Notification,
  User,
} from "../models/index.js";
import { publish } from "./notifications.js";

const openStatuses = [
  "published",
  "registration-open",
  "registration-closed",
  "ongoing",
];

export async function createReminders(now = new Date()) {
  let created = 0;
  // Narrow windows prevent a restart from sending obsolete reminders.
  for (const hours of [24, 1]) {
    const end = new Date(+now + hours * 3600_000);
    const start = new Date(+end - 10 * 60_000);
    const events = await Event.find({
      status: { $in: openStatuses },
      startDateTime: { $gt: start, $lte: end },
    }).lean();
    for (const event of events) {
      const registrations = await EventRegistration.find({
        eventId: event._id,
        registrationStatus: "confirmed",
      }).lean();
      for (const registration of registrations) {
        const deliveryKey = `reminder:${event._id}:${+event.startDateTime}:${hours}:${registration.userId}`;
        try {
          const result = await Notification.updateOne(
            { deliveryKey },
            {
              $setOnInsert: {
                deliveryKey,
                userId: registration.userId,
                eventId: event._id,
                eventStart: event.startDateTime,
                expiresAt: event.startDateTime,
                type: "event-reminder",
                title: `${event.eventName} starts in about ${hours} hour${hours === 1 ? "" : "s"}`,
                message: `${event.eventName} starts at ${event.startDateTime.toISOString()} (UTC). Location: ${event.location}. Open CourtSide for current details.`,
                emailState: "pending",
              },
            },
            { upsert: true },
          );
          created += result.upsertedCount;
        } catch (error) {
          if (error.code !== 11000) throw error;
        }
      }
    }
  }
  if (created) publish();
  return created;
}

export async function deliverAlerts(config, { now = new Date(), send } = {}) {
  if (!send && (!config.SMTP_HOST || !config.MAIL_FROM)) return;
  const transport = send
    ? null
    : nodemailer.createTransport({
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        secure: config.SMTP_PORT === 465,
        auth: config.SMTP_USER
          ? { user: config.SMTP_USER, pass: config.SMTP_PASS }
          : undefined,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      });
  const deliver = send || ((message) => transport.sendMail(message));
  for (let count = 0; count < 100; count++) {
    const alert = await Notification.findOneAndUpdate(
      {
        emailAttempts: { $lt: 3 },
        $or: [
          {
            emailState: "pending",
            $or: [
              { emailAttemptAt: { $exists: false } },
              { emailAttemptAt: { $lte: new Date(+now - 60_000) } },
            ],
          },
          {
            emailState: "sending",
            emailAttemptAt: { $lte: new Date(+now - 120_000) },
          },
        ],
      },
      {
        $set: { emailState: "sending", emailAttemptAt: now },
        $inc: { emailAttempts: 1 },
      },
      { returnDocument: "after", sort: { expiresAt: 1 } },
    );
    if (!alert) break;
    const claim = {
      _id: alert._id,
      emailState: "sending",
      emailAttempts: alert.emailAttempts,
    };
    try {
      const user = await User.findById(alert.userId);
      const event = await Event.findById(alert.eventId);
      const registration = await EventRegistration.exists({
        eventId: alert.eventId,
        userId: alert.userId,
        registrationStatus: "confirmed",
      });
      const courtCall = alert.type === "court-call";
      const match = courtCall ? await Match.findById(alert.matchId) : null;
      const valid =
        user?.active &&
        user.emailVerified &&
        user[courtCall ? "emailCourtCalls" : "emailEventReminders"] &&
        event &&
        openStatuses.includes(event.status) &&
        registration &&
        alert.expiresAt > now &&
        (courtCall
          ? match?.matchStatus === "scheduled"
          : +event.startDateTime === +alert.eventStart);
      if (!valid) {
        await Notification.updateOne(claim, { emailState: "skipped" });
        continue;
      }
      await deliver({
        from: config.MAIL_FROM,
        to: user.email,
        subject: alert.title,
        text: `${alert.message}\n\n${config.APP_URL}/#/${courtCall ? "live-session" : `events/${event._id}`}\n\nManage email alerts in My profile.`,
        messageId: `<courtside-${alert._id}@alerts.courtside.local>`,
      });
      await Notification.updateOne(claim, { emailState: "sent" });
    } catch {
      await Notification.updateOne(claim, {
        emailState: alert.emailAttempts >= 3 ? "skipped" : "pending",
      });
      console.warn(
        `Alert delivery failed for notification ${alert._id}; attempt ${alert.emailAttempts}`,
      );
    }
  }
}

export function startAlerts(config) {
  let running;
  const tick = () => {
    if (running) return;
    running = (async () => {
      await createReminders();
      await deliverAlerts(config);
    })()
      .catch((error) => console.error("Alert worker failed", error.message))
      .finally(() => {
        running = null;
      });
  };
  const timer = setInterval(tick, 10_000);
  timer.unref();
  tick();
  return async () => {
    clearInterval(timer);
    await running;
  };
}
