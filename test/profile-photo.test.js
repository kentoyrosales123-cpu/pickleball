import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import request from "supertest";
import sharp from "sharp";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { JSDOM } from "jsdom";
import { createApp } from "../src/app.js";
import { connectDatabase, User, ProfilePhoto } from "../src/models/index.js";
import { mountPhotoUpload, photoForm } from "../public/js/profile-photo.js";

test("profile photo uploads validate, normalize, persist, replace and enforce ownership", async (t) => {
  const repl = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    binary: { version: "7.0.14", downloadDir: ".cache/mongodb-binaries" },
  });
  t.after(async () => {
    await mongoose.disconnect();
    await repl.stop();
  });
  await connectDatabase(repl.getUri());
  const config = {
    NODE_ENV: "test",
    APP_URL: "http://localhost:3000",
    JWT_SECRET: "photo-test-secret-".repeat(4),
  };
  const app = createApp(config);
  const users = await User.create(
    [1, 2].map((n) => ({
      fullName: `Photo Player ${n}`,
      username: `photo${n}`,
      email: `photo${n}@example.test`,
      passwordHash: "unused",
      provisionalRanking: 1,
    })),
  );
  const cookies = users.map(
    (u) =>
      "pms_session=" +
      jwt.sign({ version: 0 }, config.JWT_SECRET, {
        subject: String(u._id),
        issuer: "pms",
        audience: "pms-web",
        expiresIn: "1h",
      }),
  );
  const png = await sharp({
    create: { width: 900, height: 600, channels: 3, background: "red" },
  })
    .png()
    .withMetadata()
    .toBuffer();
  const upload = (bytes, type = "image/png", cookie = cookies[0]) =>
    request(app)
      .put("/api/players/me/photo")
      .set("Cookie", cookie)
      .set("X-PMS-Request", "1")
      .set("Content-Type", type)
      .send(bytes);
  assert.equal((await upload(png, "image/png", "")).status, 401);
  assert.equal(
    (
      await request(app)
        .put("/api/players/me/photo")
        .set("Cookie", cookies[0])
        .set("Content-Type", "image/png")
        .send(png)
    ).status,
    403,
  );
  assert.equal((await upload(Buffer.from("not an image"))).status, 400);
  assert.equal(
    (
      await upload(
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
        ),
      )
    ).status,
    400,
  );
  assert.equal((await upload(png, "text/plain")).status, 400);
  assert.equal((await upload(Buffer.alloc(5 * 1024 * 1024 + 1))).status, 413);
  const huge = await sharp({
    create: { width: 5100, height: 5000, channels: 3, background: "red" },
  })
    .png()
    .toBuffer();
  assert.equal((await upload(huge)).status, 400);
  const saved = await upload(png);
  assert.equal(saved.status, 200);
  const url = saved.body.user.profileImage;
  assert.match(url, new RegExp(`/api/players/${users[0]._id}/photo`));
  assert.equal((await request(app).get(url)).status, 401);
  const image = await request(app).get(url).set("Cookie", cookies[1]);
  assert.equal(image.status, 200);
  assert.match(image.headers["content-type"], /image\/jpeg/);
  const metadata = await sharp(image.body).metadata();
  assert.equal(metadata.width, 512);
  assert.equal(metadata.height, 512);
  assert.equal(metadata.exif, undefined);
  assert.equal((await User.findById(users[1]._id)).profileImage, undefined);
  const webp = await sharp(png).webp().toBuffer();
  assert.equal((await upload(webp, "image/webp")).status, 200);
  const jpeg = await sharp(png).jpeg().toBuffer();
  assert.equal((await upload(jpeg, "image/jpeg")).status, 200);
  assert.equal(await ProfilePhoto.countDocuments(), 1);
  assert.equal((await upload(Buffer.from("broken"))).status, 400);
  assert.equal(
    (await request(app).get(url).set("Cookie", cookies[0])).status,
    200,
  );
  const removed = await request(app)
    .delete("/api/players/me/photo")
    .set("Cookie", cookies[0])
    .set("X-PMS-Request", "1");
  assert.equal(removed.status, 200);
  assert.equal(removed.body.user.profileImage, "");
  assert.equal(await ProfilePhoto.countDocuments(), 0);
  assert.equal(
    (await request(app).get(url).set("Cookie", cookies[1])).status,
    404,
  );
});

test("photo controls validate files, upload raw bytes, show errors and remove photos", async (t) => {
  const dom = new JSDOM(
    `<main>${photoForm({ profileImage: "/photo" })}</main>`,
  );
  t.after(() => dom.window.close());
  const container = dom.window.document.querySelector("main");
  const input = container.querySelector("input");
  let files = [],
    calls = [],
    saved;
  Object.defineProperty(input, "files", { get: () => files });
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, ...options });
    return {
      ok: true,
      json: async () => ({ user: { profileImage: "saved" } }),
    };
  });
  mountPhotoUpload(container, (user) => {
    saved = user;
  });
  const submit = () =>
    container.querySelector("form").onsubmit({ preventDefault() {} });
  await submit();
  assert.match(container.textContent, /Choose a JPEG/);
  files = [{ type: "image/png", size: 6 * 1024 * 1024 }];
  await submit();
  assert.match(container.textContent, /no larger than 5 MB/);
  assert.equal(calls.length, 0);
  files = [{ type: "image/png", size: 100 }];
  await submit();
  assert.equal(calls[0].body, files[0]);
  assert.equal(calls[0].headers["X-PMS-Request"], "1");
  assert.equal(saved.profileImage, "saved");
  await container.querySelector("#remove-photo").onclick();
  assert.equal(calls[1].method, "DELETE");
  t.mock.method(globalThis, "fetch", async () => ({
    ok: false,
    json: async () => ({ message: "Upload failed" }),
  }));
  await submit();
  assert.match(container.textContent, /Upload failed/);
  assert.equal(input.disabled, false);
});
