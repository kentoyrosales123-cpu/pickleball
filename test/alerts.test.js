import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../src/app.js";
import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import {
  connectDatabase,
  User,
  Event,
  EventRegistration,
  Notification,
  Match,
} from "../src/models/index.js";
import { createReminders, deliverAlerts } from "../src/services/alerts.js";

test("reminders and court emails deduplicate, respect preferences, retry and suppress stale alerts", async (t) => {
  const repl = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    binary: { version: "7.0.14", downloadDir: ".cache/mongodb-binaries" },
  });
  t.after(async () => {
    await mongoose.disconnect();
    await repl.stop();
  });
  await connectDatabase(repl.getUri());
  await Notification.init();
  const now = new Date("2026-11-14T00:00:00Z");
  const user = await User.create({
    fullName: "Alert Player",
    username: "alerts",
    email: "alerts@example.test",
    passwordHash: "unused",
    provisionalRanking: 1,
    emailVerified: true,
    emailEventReminders: true,
    emailCourtCalls: true,
  });
  const apiConfig = {
    NODE_ENV: "test",
    APP_URL: "http://localhost:3000",
    JWT_SECRET: "test-secret-".repeat(5),
  };
  const app = createApp(apiConfig);
  const cookie =
    "pms_session=" +
    jwt.sign({ version: 0 }, apiConfig.JWT_SECRET, {
      subject: String(user._id),
      issuer: "pms",
      audience: "pms-web",
      expiresIn: "1h",
    });
  const prefs = await request(app)
    .put("/api/players/me")
    .set("Cookie", cookie)
    .set("X-PMS-Request", "1")
    .send({
      fullName: user.fullName,
      emailEventReminders: true,
      emailCourtCalls: true,
    });
  assert.equal(prefs.status, 200);
  assert.equal(prefs.body.user.emailCourtCalls, true);
  assert.equal(
    (
      await request(app)
        .put("/api/players/me")
        .set("Cookie", cookie)
        .set("X-PMS-Request", "1")
        .send({ fullName: user.fullName, emailCourtCalls: "yes" })
    ).status,
    400,
  );
  const event = await Event.create({
    eventName: "Morning play",
    eventType: "open-play",
    location: "Club",
    startDateTime: new Date(+now + 3600_000),
    endDateTime: new Date(+now + 7200_000),
    registrationOpen: now,
    registrationDeadline: now,
    capacity: 8,
    createdBy: user._id,
    status: "registration-open",
  });
  await EventRegistration.create({
    eventId: event._id,
    userId: user._id,
    registrationStatus: "confirmed",
  });
  await Promise.all([createReminders(now), createReminders(now)]);
  assert.equal(await Notification.countDocuments(), 1);
  const config = {
    APP_URL: "https://club.example",
    MAIL_FROM: "club@example.test",
  };
  const messages = [];
  const send = async (message) => messages.push(message);
  await Promise.all([
    deliverAlerts(config, { now, send }),
    deliverAlerts(config, { now, send }),
  ]);
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /Morning play/);
  const makeAlert = (extra = {}) =>
    Notification.create({
      userId: user._id,
      eventId: event._id,
      eventStart: event.startDateTime,
      expiresAt: event.startDateTime,
      type: "event-reminder",
      title: "Reminder",
      message: "Play soon",
      emailState: "pending",
      ...extra,
    });
  user.emailEventReminders = false;
  await user.save();
  await makeAlert();
  await deliverAlerts(config, { now, send });
  assert.equal(messages.length, 1);
  user.emailEventReminders = true;
  user.emailVerified = false;
  await user.save();
  await makeAlert();
  await deliverAlerts(config, { now, send });
  assert.equal(messages.length, 1);
  user.emailVerified = true;
  await user.save();
  await makeAlert({ eventStart: new Date(+event.startDateTime + 1) });
  await makeAlert({ expiresAt: now });
  await deliverAlerts(config, { now, send });
  assert.equal(messages.length, 1);
  const retry = await makeAlert();
  await deliverAlerts(config, {
    now,
    send: async () => {
      throw Error("SMTP unavailable");
    },
  });
  assert.equal((await Notification.findById(retry._id)).emailState, "pending");
  await deliverAlerts(config, { now, send });
  assert.equal(messages.length, 1);
  await deliverAlerts(config, { now: new Date(+now + 60_000), send });
  assert.equal(messages.length, 2);
  const match = await Match.create({
    eventId: event._id,
    matchStatus: "scheduled",
  });
  await makeAlert({ type: "court-call", matchId: match._id });
  await deliverAlerts(config, { now, send });
  assert.equal(messages.length, 3);
  match.matchStatus = "finalized";
  await match.save();
  await makeAlert({ type: "court-call", matchId: match._id });
  await deliverAlerts(config, { now, send });
  assert.equal(messages.length, 3);
  await EventRegistration.updateOne(
    { userId: user._id },
    { registrationStatus: "cancelled" },
  );
  await makeAlert();
  await deliverAlerts(config, { now, send });
  assert.equal(messages.length, 3);
  event.status = "cancelled";
  await event.save();
  assert.equal(await createReminders(now), 0);
});
