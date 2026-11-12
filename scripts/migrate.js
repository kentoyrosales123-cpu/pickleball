import { migrateSuperAdmin } from "../src/migrations/003-super-admin.js";
import { migrateStarRanking } from "../src/migrations/002-star-ranking.js";
import mongoose from "mongoose";
import { getConfig } from "../src/config.js";
import { connectDatabase } from "../src/models/index.js";
import { migrateRatings } from "../src/migrations/001-doubles-ratings.js";
const config = getConfig();
try {
  await connectDatabase(config.MONGODB_URI);
  console.log(await migrateRatings());
  console.log(await migrateStarRanking());
  console.log(await migrateSuperAdmin());
} finally {
  await mongoose.disconnect();
}
