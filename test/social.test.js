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
  Friendship,
} from "../src/models/index.js";

let repl, app, alice, bob, carol, inactive;
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
  const base = { passwordHash: "unused", provisionalRanking: 3 };
  [alice, bob, carol, inactive] = await User.create([
    {
      ...base,
      fullName: "Alice Dinker",
      username: "alice",
      email: "alice@example.test",
    },
    {
      ...base,
      fullName: "Bob Volley",
      username: "bobv",
      email: "bob@example.test",
    },
    {
      ...base,
      fullName: "Carol Smash",
      username: "carol",
      email: "carol@example.test",
    },
    {
      ...base,
      fullName: "Dina Gone",
      username: "dina",
      email: "dina@example.test",
      active: false,
    },
  ]);
});
after(async () => {
  await mongoose.disconnect();
  await repl?.stop();
});

test("search finds active players by name or username, never exposes email", async () => {
  assert.equal((await call("get", "/players/search?q=a", alice)).status, 400);
  const byName = await call("get", "/players/search?q=volley", alice);
  assert.equal(byName.status, 200);
  assert.deepEqual(
    byName.body.players.map((p) => p.username),
    ["bobv"],
  );
  assert.equal(byName.body.players[0].status, "none");
  assert.equal(byName.body.players[0].email, undefined);
  const self = await call("get", "/players/search?q=alice", alice);
  assert.equal(self.body.players.length, 0, "excludes the searcher");
  const gone = await call("get", "/players/search?q=dina", alice);
  assert.equal(gone.body.players.length, 0, "excludes inactive players");
  const regex = await call("get", "/players/search?q=.*", alice);
  assert.equal(regex.body.players.length, 0, "treats input literally");
});

test("friend requests: send, accept, decline, cancel and remove", async () => {
  // Messaging is blocked before friendship.
  const early = await call("post", `/messages/${bob._id}`, alice, {
    body: "hi",
  });
  assert.equal(early.status, 403);

  const sent = await call("post", "/friends/requests", alice, {
    userId: String(bob._id),
  });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.status, "outgoing");
  assert.ok(await Notification.findOne({ userId: bob._id, type: "friend" }));
  const again = await call("post", "/friends/requests", alice, {
    userId: String(bob._id),
  });
  assert.equal(again.body.status, "outgoing");
  assert.equal(await Friendship.countDocuments(), 1);

  const bobView = await call("get", "/friends", bob);
  assert.equal(bobView.body.incoming.length, 1);
  const requestId = bobView.body.incoming[0].requestId;
  // Only the recipient can respond.
  assert.equal(
    (
      await call("put", `/friends/requests/${requestId}`, alice, {
        accept: true,
      })
    ).status,
    404,
  );
  const accepted = await call("put", `/friends/requests/${requestId}`, bob, {
    accept: true,
  });
  assert.equal(accepted.body.status, "friends");
  const aliceView = await call("get", "/friends", alice);
  assert.deepEqual(
    aliceView.body.friends.map((f) => f.username),
    ["bobv"],
  );
  const search = await call("get", "/players/search?q=bob", alice);
  assert.equal(search.body.players[0].status, "friends");

  // Declining deletes the request.
  await call("post", "/friends/requests", carol, { userId: String(alice._id) });
  const incoming = (await call("get", "/friends", alice)).body.incoming;
  await call("put", `/friends/requests/${incoming[0].requestId}`, alice, {
    accept: false,
  });
  assert.equal((await call("get", "/friends", carol)).body.outgoing.length, 0);

  // Mutual requests auto-accept.
  await call("post", "/friends/requests", carol, { userId: String(bob._id) });
  const mutual = await call("post", "/friends/requests", bob, {
    userId: String(carol._id),
  });
  assert.equal(mutual.body.status, "friends");

  // Cancel and validation.
  await call("post", "/friends/requests", alice, { userId: String(carol._id) });
  const cancelled = await call("delete", `/friends/${carol._id}`, alice);
  assert.match(cancelled.body.message, /cancelled/);
  assert.equal(
    (
      await call("post", "/friends/requests", alice, {
        userId: String(alice._id),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call("post", "/friends/requests", alice, {
        userId: String(inactive._id),
      })
    ).status,
    404,
  );
});

test("friends can message; threads, unread counts and read receipts work", async () => {
  const empty = await call("post", `/messages/${bob._id}`, alice, {
    body: "   ",
  });
  assert.equal(empty.status, 400);
  const sent = await call("post", `/messages/${bob._id}`, alice, {
    body: "Game at 6?",
  });
  assert.equal(sent.status, 201);
  await call("post", `/messages/${bob._id}`, alice, {
    body: "<b>bring balls</b>",
  });
  await call("post", `/messages/${alice._id}`, bob, { body: "Sure!" });

  assert.equal((await call("get", "/messages/unread", bob)).body.count, 2);
  const convos = await call("get", "/messages", bob);
  const withAlice = convos.body.conversations.find(
    (c) => c.player.username === "alice",
  );
  assert.equal(withAlice.unread, 2);
  assert.equal(withAlice.lastMessage.body, "Sure!");
  assert.ok(
    convos.body.conversations.some((c) => c.player.username === "carol"),
  );

  const thread = await call("get", `/messages/${alice._id}`, bob);
  assert.deepEqual(
    thread.body.messages.map((m) => m.body),
    ["Game at 6?", "<b>bring balls</b>", "Sure!"],
  );
  assert.equal(thread.body.friends, true);
  assert.equal((await call("get", "/messages/unread", bob)).body.count, 0);
  const aliceThread = await call("get", `/messages/${bob._id}`, alice);
  assert.ok(aliceThread.body.messages[0].readAt, "sender sees read receipt");

  // Carol can't read Alice and Bob's thread by guessing ids: she only sees her own pair.
  const carolThread = await call("get", `/messages/${alice._id}`, carol);
  assert.equal(carolThread.body.messages.length, 0);

  // After unfriending, history stays readable but sending is blocked.
  await call("delete", `/friends/${bob._id}`, alice);
  const after = await call("get", `/messages/${bob._id}`, alice);
  assert.equal(after.body.friends, false);
  assert.equal(after.body.messages.length, 3);
  assert.equal(
    (await call("post", `/messages/${bob._id}`, alice, { body: "hello?" }))
      .status,
    403,
  );
});

test("thread pagination returns 50 at a time", async () => {
  await call("post", "/friends/requests", alice, { userId: String(carol._id) });
  const { incoming } = (await call("get", "/friends", carol)).body;
  await call("put", `/friends/requests/${incoming[0].requestId}`, carol, {
    accept: true,
  });
  for (let i = 0; i < 55; i++)
    await call("post", `/messages/${carol._id}`, alice, { body: `msg ${i}` });
  const page = await call("get", `/messages/${carol._id}`, alice);
  assert.equal(page.body.messages.length, 50);
  assert.equal(page.body.hasMore, true);
  assert.equal(page.body.messages.at(-1).body, "msg 54");
  const older = await call(
    "get",
    `/messages/${carol._id}?before=${page.body.messages[0].id}`,
    alice,
  );
  assert.equal(older.body.hasMore, false);
  assert.equal(older.body.messages.length, 5);
});
