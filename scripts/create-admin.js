import bcrypt from "bcrypt";
import mongoose from "mongoose";
import { getConfig } from "../src/config.js";
import { connectDatabase, User } from "../src/models/index.js";
const config = getConfig();
if (config.NODE_ENV !== "development")
  throw new Error("Administrator bootstrap is development-only");
if (!process.env.ADMIN_EMAIL) throw new Error("Set ADMIN_EMAIL");
// The development administrator may use an explicitly chosen password of 8+ characters.
if (
  !process.env.ADMIN_PASSWORD ||
  process.env.ADMIN_PASSWORD.length < 8 ||
  Buffer.byteLength(process.env.ADMIN_PASSWORD) > 72
)
  throw new Error("ADMIN_PASSWORD must contain 8–72 UTF-8 bytes");
await connectDatabase(config.MONGODB_URI);
try {
  if (await User.exists({ role: { $in: ["admin", "super-admin"] } }))
    throw new Error("An administrator already exists");
  await User.create({
    fullName: "Club Administrator",
    username: "administrator",
    email: process.env.ADMIN_EMAIL.toLowerCase(),
    passwordHash: await bcrypt.hash(process.env.ADMIN_PASSWORD, 12),
    role: "super-admin",
    provisionalRanking: 1,
    emailVerified: true,
  });
  console.log(
    "Administrator created. Remove ADMIN_PASSWORD from your environment.",
  );
} finally {
  await mongoose.disconnect();
}
