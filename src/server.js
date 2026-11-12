import { migrateSuperAdmin } from "./migrations/003-super-admin.js";
import { migrateStarRanking } from "./migrations/002-star-ranking.js";
import http from "node:http";
import mongoose from "mongoose";
import { Server } from "socket.io";
import { getConfig } from "./config.js";
import { connectDatabase } from "./models/index.js";
import { createApp } from "./app.js";
import { identify } from "./middleware/security.js";
import { setSocket } from "./services/notifications.js";
import { migrateRatings } from "./migrations/001-doubles-ratings.js";
const config = getConfig();
await connectDatabase(config.MONGODB_URI);
await migrateRatings();
await migrateStarRanking();
await migrateSuperAdmin();
const server = http.createServer(createApp(config));
const io = new Server(server, {
  cors: { origin: config.ALLOWED_ORIGINS, credentials: true },
  allowRequest: (req, done) =>
    done(null, config.ALLOWED_ORIGINS.includes(req.headers.origin)),
});
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.headers.cookie
      ?.split("; ")
      .find((c) => c.startsWith("pms_session="))
      ?.slice(12);
    socket.user = await identify(token, config);
    next();
  } catch {
    next(new Error("Unauthorized"));
  }
});
io.on("connection", (socket) => {
  socket.join(String(socket.user._id));
  const timer = setInterval(async () => {
    try {
      const token = socket.handshake.headers.cookie
        ?.split("; ")
        .find((c) => c.startsWith("pms_session="))
        ?.slice(12);
      await identify(token, config);
    } catch {
      socket.disconnect(true);
    }
  }, 60_000);
  socket.on("disconnect", () => clearInterval(timer));
});
setSocket(io);
server.listen(config.PORT, () =>
  console.log(`CourtSide running at ${config.APP_URL}`),
);
async function shutdown() {
  io.close();
  server.close();
  await mongoose.disconnect();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
