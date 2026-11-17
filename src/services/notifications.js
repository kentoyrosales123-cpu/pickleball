import { Notification, AuditLog } from "../models/index.js";
let io;
export const setSocket = (socket) => {
  io = socket;
};
export async function notify(
  users,
  title,
  message,
  type = "event",
  session,
  alert = {},
) {
  if (!users.length) return [];
  return Notification.insertMany(
    [...new Set(users.map(String))].map((userId) => ({
      userId,
      title,
      message,
      type,
      ...alert,
    })),
    { session },
  );
}
export function publish() {
  io?.emit("refresh");
  io?.emit("ranking:leaderboard-changed");
}
// Refreshes only the given users' clients (call after commit).
export function publishTo(userIds) {
  for (const id of new Set(userIds.map(String))) io?.to(id).emit("refresh");
}
// Sends a socket event to each given user's open clients (e.g. chat messages).
export function emitTo(userIds, event, payload) {
  for (const id of new Set(userIds.map(String)))
    io?.to(id).emit(event, payload);
}
// Called only after the surrounding result transaction has committed.
export async function publishRankingResult(matchId) {
  if (!io) return;
  const { RankingHistory } = await import("../models/ranking.js");
  const rows = await RankingHistory.find({ matchId }).lean();
  for (const row of rows)
    io.to(String(row.playerId)).emit("ranking:result", {
      matchId: String(matchId),
      starsChanged: row.starsChanged,
      protectionActivated: row.protectionActivated,
      doubleStarActivated: row.doubleStarActivated,
      rankPromoted: row.rankPromoted,
      rankDemoted: row.rankDemoted,
      rankTier: row.after.rankTier,
      rankDivision: row.after.rankDivision,
    });
}
export const audit = (
  actorId,
  action,
  entityType,
  entityId,
  previousValue,
  newValue,
  session,
) =>
  AuditLog.create(
    [
      {
        actorId,
        action,
        entityType,
        entityId: String(entityId),
        previousValue,
        newValue,
      },
    ],
    { session },
  );
