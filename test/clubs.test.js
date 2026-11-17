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
  Event,
  Notification,
  EventRegistration,
} from "../src/models/index.js";

let repl, app, owner, host, member, outsider, adminUser;
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
const hours = (h) => new Date(Date.now() + h * 3600_000).toISOString();
const meetup = (over = {}) => ({
  eventName: "Tuesday Night Dinks",
  location: "Matina Courts",
  startDateTime: hours(1),
  endDateTime: hours(3),
  capacity: 4,
  fee: 150,
  ...over,
});

before(async () => {
  repl = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    binary: { version: "7.0.14", downloadDir: ".cache/mongodb-binaries" },
  });
  await connectDatabase(repl.getUri());
  app = createApp(config);
  const base = { passwordHash: "unused", provisionalRanking: 3 };
  [owner, host, member, outsider, adminUser] = await User.create(
    ["owner", "host", "member", "outsider", "admin"].map((n) => ({
      ...base,
      fullName: `${n[0].toUpperCase()}${n.slice(1)} Player`,
      username: n,
      email: `${n}@example.test`,
      role: n === "admin" ? "admin" : "player",
    })),
  );
});
after(async () => {
  await mongoose.disconnect();
  await repl?.stop();
});

let clubId, eventId;

test("players create, find and join clubs; names are unique ignoring case", async () => {
  const created = await call("post", "/clubs", owner, {
    name: "Davao Dinkers",
    location: "Davao City",
    paymentInstructions: "GCash 0917 000 0000 (Owner P.)",
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.club.myRole, "owner");
  assert.equal(created.body.club.memberCount, 1);
  clubId = created.body.club.id;

  const dup = await call("post", "/clubs", outsider, { name: "davao dinkers" });
  assert.equal(dup.status, 409);

  for (const u of [host, member]) {
    const j = await call("post", `/clubs/${clubId}/join`, u);
    assert.equal(j.status, 200);
  }
  // Joining twice is harmless and does not double count.
  await call("post", `/clubs/${clubId}/join`, member);
  const list = await call("get", "/clubs?q=dink", member);
  assert.equal(list.body.clubs.length, 1);
  assert.equal(list.body.clubs[0].memberCount, 3);
  assert.equal(list.body.clubs[0].myRole, "member");

  const left = await call("delete", `/clubs/${clubId}/join`, owner);
  assert.equal(left.status, 409, "owner cannot leave");
});

test("only the owner promotes hosts; members cannot post meetups", async () => {
  assert.equal(
    (await call("post", `/clubs/${clubId}/meetups`, member, meetup())).status,
    403,
  );
  assert.equal(
    (
      await call("put", `/clubs/${clubId}/members/${member._id}`, host, {
        role: "host",
      })
    ).status,
    403,
  );
  const promoted = await call(
    "put",
    `/clubs/${clubId}/members/${host._id}`,
    owner,
    { role: "host" },
  );
  assert.equal(promoted.status, 200);
  const detail = await call("get", `/clubs/${clubId}`, host);
  assert.equal(detail.body.club.myRole, "host");
  assert.equal(detail.body.canManage, true);
  assert.deepEqual(
    detail.body.members.map((m) => m.role),
    ["owner", "host", "member"],
  );
});

test("hosts post meetups that notify members and use normal registration", async () => {
  const past = await call(
    "post",
    `/clubs/${clubId}/meetups`,
    host,
    meetup({ startDateTime: hours(-2), endDateTime: hours(-1) }),
  );
  assert.equal(past.status, 400);

  const res = await call("post", `/clubs/${clubId}/meetups`, host, meetup());
  assert.equal(res.status, 201);
  eventId = res.body.event._id;
  assert.equal(res.body.event.status, "registration-open");
  assert.equal(res.body.event.clubId, clubId);
  assert.equal(res.body.event.eventType, "open-play");

  const notes = await Notification.find({ title: /New meetup/ });
  assert.deepEqual(
    notes.map((n) => String(n.userId)).sort(),
    [String(owner._id), String(member._id)].sort(),
    "every member except the poster is notified",
  );

  const join = await call("post", `/events/${eventId}/register`, member, {});
  assert.equal(join.status, 200);
  assert.equal(join.body.registration.registrationStatus, "confirmed");
  await call("post", `/events/${eventId}/register`, outsider, {});

  const detail = await call("get", `/events/${eventId}`, member);
  assert.equal(detail.body.canManage, false);
  assert.equal(detail.body.club.name, "Davao Dinkers");
  assert.match(detail.body.club.paymentInstructions, /GCash/);
  assert.equal(detail.body.myRegistration.paymentStatus, "unpaid");
  assert.equal(
    (await call("get", `/events/${eventId}`, host)).body.canManage,
    true,
  );
});

test("players submit payment references; hosts confirm them", async () => {
  const noRef = await call("put", `/events/${eventId}/payment`, member, {
    paymentMethod: "gcash",
  });
  assert.equal(noRef.status, 400);
  const submitted = await call("put", `/events/${eventId}/payment`, member, {
    paymentMethod: "gcash",
    paymentReference: "1234 567 890",
  });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.registration.paymentStatus, "submitted");
  assert.ok(
    await Notification.exists({
      userId: host._id,
      title: "Payment to confirm",
    }),
  );

  // Outsiders and plain members cannot see or change the roster.
  assert.equal(
    (await call("get", `/events/${eventId}/roster`, member)).status,
    403,
  );
  assert.equal(
    (
      await call(
        "put",
        `/events/${eventId}/roster/${member._id}/payment`,
        member,
        {
          paymentStatus: "paid",
        },
      )
    ).status,
    403,
  );

  const paid = await call(
    "put",
    `/events/${eventId}/roster/${member._id}/payment`,
    host,
    { paymentStatus: "paid" },
  );
  assert.equal(paid.status, 200);
  assert.ok(paid.body.registration.paidAt);
  const again = await call("put", `/events/${eventId}/payment`, member, {
    paymentMethod: "cash",
  });
  assert.equal(again.status, 409, "settled payments can't be resubmitted");

  const roster = await call("get", `/events/${eventId}/roster`, owner);
  assert.equal(roster.status, 200);
  assert.equal(roster.body.roster.length, 2);
  assert.equal(roster.body.summary.paid, 1);
  assert.equal(roster.body.summary.collected, 150);
  assert.equal(roster.body.roster[0].player.email, undefined);
});

test("hosts check players in and mark no-shows; history shows it", async () => {
  const checkIn = await call(
    "put",
    `/events/${eventId}/roster/${member._id}/attendance`,
    host,
    { attendance: "present" },
  );
  assert.equal(checkIn.status, 200);
  assert.ok(checkIn.body.registration.checkedInAt);
  await call(
    "put",
    `/events/${eventId}/roster/${outsider._id}/attendance`,
    host,
    { attendance: "no-show" },
  );
  const roster = await call("get", `/events/${eventId}/roster`, host);
  assert.equal(roster.body.summary.present, 1);
  assert.equal(roster.body.summary.noShow, 1);

  // Move the meetup into the past so it appears in history.
  await Event.updateOne(
    { _id: eventId },
    {
      startDateTime: new Date(Date.now() - 3 * 3600_000),
      endDateTime: new Date(Date.now() - 3600_000),
    },
  );
  const history = await call("get", "/players/me/attendance", member);
  assert.equal(history.body.summary.attended, 1);
  assert.equal(history.body.history[0].attendance, "present");
  assert.equal(history.body.history[0].paymentStatus, "paid");
  const flake = await call("get", "/players/me/attendance", outsider);
  assert.equal(flake.body.summary.noShows, 1);
});

test("check-in is not available days ahead; re-joining resets attendance", async () => {
  const later = await call(
    "post",
    `/clubs/${clubId}/meetups`,
    owner,
    meetup({ startDateTime: hours(48), endDateTime: hours(50) }),
  );
  const id = later.body.event._id;
  await call("post", `/events/${id}/register`, member, {});
  const early = await call(
    "put",
    `/events/${id}/roster/${member._id}/attendance`,
    host,
    { attendance: "present" },
  );
  assert.equal(early.status, 400);
  await EventRegistration.updateOne(
    { eventId: id, userId: member._id },
    { attendance: "no-show" },
  );
  await call("delete", `/events/${id}/register`, member);
  await call("post", `/events/${id}/register`, member, {});
  const row = await EventRegistration.findOne({
    eventId: id,
    userId: member._id,
  });
  assert.equal(row.attendance, "pending");
});

test("hosts edit and cancel meetups; club deletion waits for cancellations", async () => {
  const later = await call(
    "post",
    `/clubs/${clubId}/meetups`,
    host,
    meetup({ startDateTime: hours(24), endDateTime: hours(26), capacity: 8 }),
  );
  const id = later.body.event._id;
  await call("post", `/events/${id}/register`, member, {});
  await call("post", `/events/${id}/register`, outsider, {});

  const shrink = await call(
    "put",
    `/clubs/${clubId}/meetups/${id}`,
    host,
    meetup({
      startDateTime: hours(24),
      endDateTime: hours(26),
      capacity: 4,
      minRanking: 5,
    }),
  );
  assert.equal(shrink.status, 400, "level range would exclude joined players");

  const edited = await call(
    "put",
    `/clubs/${clubId}/meetups/${id}`,
    host,
    meetup({
      startDateTime: hours(24),
      endDateTime: hours(26),
      capacity: 6,
      eventName: "Wednesday Dinks",
    }),
  );
  assert.equal(edited.status, 200);
  assert.equal(edited.body.event.eventName, "Wednesday Dinks");

  // A meetup id from a different club is rejected.
  const other = await call("post", "/clubs", outsider, { name: "Other Club" });
  assert.equal(
    (
      await call(
        "post",
        `/clubs/${other.body.club.id}/meetups/${id}/cancel`,
        outsider,
      )
    ).status,
    404,
  );

  assert.equal((await call("delete", `/clubs/${clubId}`, host)).status, 403);
  assert.equal((await call("delete", `/clubs/${clubId}`, owner)).status, 409);

  for (const e of await Event.find({ clubId, status: { $ne: "cancelled" } }))
    assert.equal(
      (await call("post", `/clubs/${clubId}/meetups/${e._id}/cancel`, host))
        .status,
      200,
    );
  assert.ok(
    await Notification.exists({
      userId: outsider._id,
      title: "Meetup cancelled",
    }),
  );
  assert.equal((await call("delete", `/clubs/${clubId}`, owner)).status, 200);
  assert.equal((await call("get", `/clubs/${clubId}`, member)).status, 404);
});

test("admins keep full access to club meetups", async () => {
  const c = await call("post", "/clubs", owner, { name: "Admin Check Club" });
  const e = await call(
    "post",
    `/clubs/${c.body.club.id}/meetups`,
    owner,
    meetup(),
  );
  assert.equal(
    (await call("get", `/events/${e.body.event._id}/roster`, adminUser)).status,
    200,
  );
});
