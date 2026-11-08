// Ephemeral, real MongoDB development preview. Nothing is persisted after shutdown.
import "dotenv/config";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { MongoMemoryReplSet } from "mongodb-memory-server";
if (process.env.NODE_ENV === "production")
  throw new Error("Preview is development-only");
const repl = await MongoMemoryReplSet.create({
  replSet: { count: 1 },
  binary: { version: "7.0.14", downloadDir: ".cache/mongodb-binaries" },
});
const password =
  process.env.ADMIN_PASSWORD ||
  process.env.PREVIEW_PASSWORD ||
  crypto.randomBytes(18).toString("base64url");
const email = process.env.ADMIN_EMAIL || "admin@example.test";
const env = {
  ...process.env,
  NODE_ENV: "development",
  MONGODB_URI: repl.getUri(),
  JWT_SECRET: crypto.randomBytes(48).toString("hex"),
  APP_URL: "http://localhost:3000",
  PORT: "3000",
  ADMIN_EMAIL: email,
  ADMIN_PASSWORD: password,
  SEED_PASSWORD:
    process.env.SEED_PASSWORD || crypto.randomBytes(18).toString("base64url"),
};
async function run(file) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file], {
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${file} failed`)),
    );
  });
}
await run("scripts/create-admin.js");
await run("scripts/seed.js");
console.log(
  `Ephemeral preview administrator: ${email}. Password loaded from ADMIN_PASSWORD when configured.`,
);
console.log(
  "All preview database records are destroyed when the preview stops.",
);
const server = spawn(process.execPath, ["src/server.js"], {
  env,
  stdio: "inherit",
  windowsHide: true,
});
async function stop() {
  server.kill();
  await repl.stop();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
server.on("exit", async () => {
  await repl.stop();
  process.exit(0);
});
