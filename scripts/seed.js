import bcrypt from "bcrypt";
import mongoose from "mongoose";
import { getConfig } from "../src/config.js";
import {
  connectDatabase,
  User,
  Event,
  EventRegistration,
} from "../src/models/index.js";
import { password } from "../src/controllers/auth.js";
const config = getConfig();
if (config.NODE_ENV !== "development")
  throw new Error("Seed data is development-only");
password.parse(process.env.SEED_PASSWORD);
await connectDatabase(config.MONGODB_URI);
try {
  const admin = await User.findOne({ role: { $in: ["admin", "super-admin"] } });
  if (!admin) throw new Error("Run create-admin first");
  const names = [
    "Alex Reyes",
    "Jamie Santos",
    "Sam Cruz",
    "Taylor Garcia",
    "Morgan Lim",
    "Jordan Tan",
    "Casey Flores",
    "Riley Mendoza",
    "Avery Ramos",
    "Quinn Torres",
    "Drew Rivera",
    "Cameron Lee",
    "Sky Navarro",
    "Rowan Chua",
    "Parker Diaz",
    "Emery Aquino",
    "Blake Castillo",
    "Hayden Ong",
    "Finley Yu",
    "Reese Villanueva",
    "Dakota Lopez",
    "Sage Bautista",
    "River Uy",
    "Charlie Co",
  ];
  const hash = await bcrypt.hash(process.env.SEED_PASSWORD, 12);
  const players = [];
  for (const [i, fullName] of names.entries())
    players.push(
      await User.findOneAndUpdate(
        { username: `player${i + 1}` },
        {
          $setOnInsert: {
            fullName,
            email: `player${i + 1}@example.test`,
            passwordHash: hash,
            provisionalRanking: Math.floor(i / 2) + 1,
            officialRanking: Math.floor(i / 2) + 1,
            rankingStatus: "confirmed",
            emailVerified: true,
          },
        },
        { upsert: true, returnDocument: "after" },
      ),
    );
  for (const [i, eventName] of [
    "Weekend Social Rally",
    "Wednesday Night Open Play",
    "Club Championship",
  ].entries()) {
    if (await Event.exists({ eventName })) continue;
    const start = new Date(Date.now() + (7 + i * 3) * 86400_000);
    start.setUTCHours(1, 0, 0, 0);
    await mongoose.connection.transaction(async (session) => {
      const [event] = await Event.create(
        [
          {
            eventName,
            eventType: i === 2 ? "tournament" : "open-play",
            description: "Meet your club, find your rhythm, and get on court.",
            location: "Riverside Sports Center",
            startDateTime: start,
            endDateTime: new Date(+start + 12 * 3600_000),
            registrationOpen: new Date(Date.now() - 86400_000),
            registrationDeadline: new Date(+start - 86400_000),
            capacity: 32,
            courts: ["1", "2", "3", "4"],
            minRanking: 1,
            maxRanking: 12,
            status: "registration-open",
            format: i === 2 ? "single-elimination" : "round-robin",
            createdBy: admin._id,
            confirmedCount: 24,
            waitlistEnabled: true,
          },
        ],
        { session },
      );
      await EventRegistration.insertMany(
        players.map((p) => ({
          eventId: event._id,
          userId: p._id,
          registrationStatus: "confirmed",
        })),
        { session },
      );
    });
  }
  console.log(
    "Seeded 24 players across 12 levels and 3 events. Player emails: player1@example.test through player24@example.test.",
  );
} finally {
  await mongoose.disconnect();
}
