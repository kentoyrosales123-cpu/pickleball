import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import request from "supertest";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { createApp } from "../src/app.js";
import {
  connectDatabase,
  User,
  Notification,
  AuditLog,
} from "../src/models/index.js";

let repl, app, admin, player, other;
const config = {
  NODE_ENV: "test",
  APP_URL: "http://localhost:3000",
  JWT_SECRET: "test-only-secret-".repeat(5),
};
const cookie = (u) =>
  `pms_session=${jwt.sign({ version: 0 }, config.JWT_SECRET, { subject: String(u._id), expiresIn: "1h", issuer: "pms", audience: "pms-web" })}`;
const call = (method, url, user, body) => {
  const r = request(app)
    [method](`/api${url}`)
    .set("Cookie", cookie(user))
    .set("X-PMS-Request", "1");
  return body === undefined ? r : r.send(body);
};
before(async () => {
  repl = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    binary: { version: "7.0.14", downloadDir: ".cache/mongodb-binaries" },
  });
  await connectDatabase(repl.getUri());
  app = createApp(config);
  const base = { passwordHash: "unused", provisionalRanking: 1 };
  [admin, player, other] = await User.create([
    {
      ...base,
      fullName: "Club Admin",
      username: "supportadmin",
      email: "admin@example.test",
      role: "admin",
    },
    {
      ...base,
      fullName: "Reporting Player",
      username: "reporter",
      email: "reporter@example.test",
    },
    {
      ...base,
      fullName: "Other Player",
      username: "otherplayer",
      email: "other@example.test",
    },
  ]);
});
after(async () => {
  await mongoose.disconnect();
  await repl?.stop();
});

test("players report scams and bugs; admins triage and reply", async () => {
  const invalid = await call("post", "/support/tickets", player, {
    category: "phishing",
    subject: "Hi",
    message: "short",
  });
  assert.equal(invalid.status, 400);

  const created = await call("post", "/support/tickets", player, {
    category: "scam",
    subject: "Someone asked for my password",
    message: "A user messaged me claiming to be staff and asked for my login.",
    page: "Live session",
  });
  assert.equal(created.status, 201);
  assert.match(created.body.message, /urgently/);
  const id = created.body.ticket._id;
  assert.equal(created.body.ticket.status, "open");

  const adminAlert = await Notification.findOne({ userId: admin._id });
  assert.match(adminAlert.title, /Scam or fraud/);
  assert.equal(await AuditLog.countDocuments({ action: "support.create" }), 1);

  const mine = await call("get", "/support/tickets/mine", player);
  assert.equal(mine.body.tickets.length, 1);
  const othersView = await call("get", "/support/tickets/mine", other);
  assert.equal(othersView.body.tickets.length, 0);

  assert.equal(
    (await call("get", "/admin/support/tickets", player)).status,
    403,
  );
  assert.equal(
    (
      await call("put", `/admin/support/tickets/${id}`, player, {
        status: "resolved",
      })
    ).status,
    403,
  );

  const inbox = await call("get", "/admin/support/tickets?status=open", admin);
  assert.equal(inbox.status, 200);
  assert.equal(inbox.body.tickets.length, 1);
  assert.equal(inbox.body.tickets[0].userId.fullName, "Reporting Player");
  assert.equal(inbox.body.counts.open, 1);

  const updated = await call("put", `/admin/support/tickets/${id}`, admin, {
    status: "resolved",
    adminReply: "The account has been suspended. Thank you.",
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.ticket.status, "resolved");
  assert.ok(updated.body.ticket.resolvedAt);
  assert.equal(updated.body.ticket.handledBy.fullName, "Club Admin");

  const reply = await Notification.findOne({ userId: player._id });
  assert.match(reply.title, /resolved/);
  assert.match(reply.message, /suspended/);

  const missing = await call("put", "/admin/support/tickets/not-an-id", admin, {
    status: "open",
  });
  assert.equal(missing.status, 404);
});
