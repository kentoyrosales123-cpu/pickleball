import "./ranking.js";
import mongoose from "mongoose";
import { DEFAULT_RATING_POLICY, seedRating } from "../domain/ratings.js";
const { Schema } = mongoose;
const ref = (model, required = true) => ({
  type: Schema.Types.ObjectId,
  ref: model,
  required,
});
const rank = { type: Number, min: 1, max: 12, validate: Number.isInteger };
const options = { timestamps: true, strict: "throw" };
const ratingPolicy = new Schema(
  {
    enabled: { type: Boolean, default: false },
    kFactor: { type: Number, default: 32, min: 1, max: 128 },
    minimumRatedMatches: { type: Number, default: 10, min: 10, max: 1000 },
    hysteresis: { type: Number, default: 20, min: 0, max: 100 },
    promotionThresholds: {
      type: [Number],
      default: () => [...DEFAULT_RATING_POLICY.promotionThresholds],
    },
    demotionThresholds: {
      type: [Number],
      default: () => [...DEFAULT_RATING_POLICY.demotionThresholds],
    },
  },
  { _id: false, versionKey: false, strict: "throw" },
);
export const RANKINGS = [
  "Lower Beginner",
  "Beginner",
  "Advance Beginner",
  "Lower Novice",
  "Novice",
  "Advance Novice",
  "Lower Intermediate",
  "Intermediate",
  "Advance Intermediate",
  "Lower Pro",
  "Pro",
  "Advance Pro",
];
const user = new Schema(
  {
    fullName: { type: String, required: true, maxlength: 100 },
    username: { type: String, required: true, unique: true, lowercase: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    phone: String,
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ["player", "admin"], default: "player" },
    profileImage: String,
    gender: String,
    dateOfBirth: Date,
    provisionalRanking: { ...rank, required: true },
    officialRanking: rank,
    rankingStatus: {
      type: String,
      enum: ["provisional", "confirmed"],
      default: "provisional",
    },
    doublesRating: Number,
    doublesRatedMatches: { type: Number, default: 0 },
    automaticRanking: rank,
    automaticRankingStatus: {
      type: String,
      enum: ["provisional", "confirmed"],
      default: "provisional",
    },
    rankingOverride: { type: Boolean, default: false },
    emailVerified: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
    tokenVersion: { type: Number, default: 0, select: false },
  },
  options,
);
user.pre("validate", function () {
  const initialRank = this.officialRanking || this.provisionalRanking;
  if (this.isNew && Number.isInteger(initialRank)) {
    if (this.doublesRating == null)
      this.doublesRating = seedRating(initialRank);
    if (this.automaticRanking == null) this.automaticRanking = initialRank;
  }
});
const event = new Schema(
  {
    eventName: { type: String, required: true },
    eventType: {
      type: String,
      enum: ["open-play", "tournament"],
      required: true,
    },
    description: String,
    location: { type: String, required: true },
    startDateTime: { type: Date, required: true },
    endDateTime: { type: Date, required: true },
    registrationOpen: { type: Date, required: true },
    registrationDeadline: { type: Date, required: true },
    capacity: { type: Number, min: 4, max: 256, required: true },
    confirmedCount: { type: Number, default: 0, min: 0 },
    waitlistEnabled: { type: Boolean, default: false },
    minRanking: { ...rank, default: 1 },
    maxRanking: { ...rank, default: 12 },
    fee: { type: Number, min: 0, default: 0 },
    courts: { type: [String], default: ["1"] },
    format: {
      type: String,
      enum: [
        "random",
        "round-robin",
        "balanced",
        "rotating",
        "single-elimination",
        "double-elimination",
        "group-knockout",
      ],
      default: "round-robin",
    },
    teamMode: {
      type: String,
      enum: ["random", "balanced", "same-rank", "manual", "player-selected"],
      default: "balanced",
    },
    targetPoints: { type: Number, enum: [11, 15, 21], default: 11 },
    winningMargin: { type: Number, min: 1, max: 10, default: 2 },
    bestOf: { type: Number, enum: [1, 3], default: 1 },
    matchDuration: { type: Number, min: 5, max: 180, default: 20 },
    rounds: { type: Number, min: 1, max: 30, default: 3 },
    status: {
      type: String,
      enum: [
        "draft",
        "published",
        "registration-open",
        "registration-closed",
        "ongoing",
        "completed",
        "cancelled",
      ],
      default: "draft",
    },
    createdBy: ref("User"),
    revision: { type: Number, default: 0 },
    activeBatch: String,
    finalizedBatch: String,
    grandFinalReset: { type: Boolean, default: true },
    groupCount: { type: Number, min: 2, max: 8, default: 2 },
    rated: { type: Boolean, default: false },
  },
  options,
);
event.index({ status: 1, startDateTime: 1 });
const registration = new Schema(
  {
    eventId: ref("Event"),
    userId: ref("User"),
    registrationStatus: {
      type: String,
      enum: ["confirmed", "waitlisted", "cancelled"],
      required: true,
    },
    registeredAt: { type: Date, default: Date.now },
    waitlistPosition: Number,
  },
  options,
);
registration.index({ eventId: 1, userId: 1 }, { unique: true });
const team = new Schema(
  {
    eventId: ref("Event"),
    generationBatchId: { type: String, required: true },
    roundNumber: { type: Number, default: 1 },
    players: {
      type: [ref("User")],
      validate: (a) => a.length === 2 && String(a[0]) !== String(a[1]),
    },
    combinedRanking: Number,
    combinedRating: Number,
    assignmentStatus: {
      type: String,
      enum: ["draft", "finalized"],
      default: "draft",
    },
  },
  options,
);
const match = new Schema(
  {
    eventId: ref("Event"),
    roundNumber: Number,
    courtNumber: String,
    teamA: ref("Team", false),
    teamB: ref("Team", false),
    scores: [
      new Schema(
        { a: Number, b: Number },
        { _id: false, versionKey: false, strict: "throw" },
      ),
    ],
    winner: ref("Team", false),
    matchStatus: {
      type: String,
      enum: ["pending", "scheduled", "finalized", "bye"],
      default: "scheduled",
    },
    startDateTime: Date,
    completedAt: Date,
    bracketKey: String,
    sources: [String],
    stage: String,
    revision: { type: Number, default: 0 },
    rated: { type: Boolean, default: false },
    ratingPolicy: { type: ratingPolicy, default: undefined },
    starPolicy: Schema.Types.Mixed,
    rankingSeasonId: { type: Schema.Types.ObjectId, ref: "RankingSeason" },
    rankingApplied: { type: Boolean, default: false },
    rankingVersion: { type: Number, default: 0 },
    finalizedBy: ref("User", false),
  },
  options,
);
match.index(
  { eventId: 1, bracketKey: 1 },
  {
    unique: true,
    partialFilterExpression: { bracketKey: { $type: "string" } },
  },
);
match.index({ matchStatus: 1, rated: 1, completedAt: 1, _id: 1 });
const tournament = new Schema(
  {
    eventId: { ...ref("Event"), unique: true },
    bracketType: String,
    bracketData: Schema.Types.Mixed,
    standings: [Schema.Types.Mixed],
    champion: ref("Team", false),
  },
  options,
);
const history = new Schema(
  {
    playerId: ref("User"),
    oldRanking: Number,
    newRanking: { ...rank, required: true },
    changedBy: ref("User"),
    reason: String,
    changedAt: { type: Date, default: Date.now },
  },
  options,
);
const notification = new Schema(
  {
    userId: ref("User"),
    title: String,
    message: String,
    type: String,
    isRead: { type: Boolean, default: false },
  },
  options,
);
notification.index({ userId: 1, createdAt: -1 });
const audit = new Schema(
  {
    actorId: ref("User"),
    action: String,
    entityType: String,
    entityId: String,
    previousValue: Schema.Types.Mixed,
    newValue: Schema.Types.Mixed,
    timestamp: { type: Date, default: Date.now },
  },
  options,
);
const token = new Schema(
  {
    userId: ref("User"),
    hash: { type: String, unique: true },
    purpose: { type: String, enum: ["verify", "reset"] },
    expiresAt: Date,
  },
  options,
);
token.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const settings = new Schema(
  {
    key: { type: String, unique: true, default: "global" },
    leaderboardOrder: {
      type: String,
      enum: ["wins", "winRate", "points", "rating"],
      default: "wins",
    },
    minimumMatches: { type: Number, default: 5, min: 0 },
    rating: { type: ratingPolicy, default: () => ({}) },
    ratingRevision: { type: Number, default: 0 },
    showRankingMMR: { type: Boolean, default: false },
  },
  options,
);
const proposal = new Schema(
  {
    eventId: ref("Event"),
    requestedBy: ref("User"),
    partnerId: ref("User"),
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    reviewedBy: ref("User", false),
  },
  options,
);
proposal.index({ eventId: 1, requestedBy: 1 }, { unique: true });
const playerRating = new Schema(
  {
    playerId: ref("User"),
    pool: { type: String, enum: ["doubles"], default: "doubles" },
    baselineRating: { type: Number, required: true },
    baselineRank: { ...rank, required: true },
    baselineOfficialRanking: rank,
    baselineRankingStatus: {
      type: String,
      enum: ["provisional", "confirmed"],
      required: true,
    },
    rating: { type: Number, required: true },
    rank: { ...rank, required: true },
    ratedMatches: { type: Number, default: 0 },
    automaticConfirmed: { type: Boolean, default: false },
    manualLocked: { type: Boolean, default: false },
  },
  options,
);
playerRating.index({ playerId: 1, pool: 1 }, { unique: true });
const ratingOverride = new Schema(
  {
    playerId: ref("User"),
    pool: { type: String, enum: ["doubles"], default: "doubles" },
    action: { type: String, enum: ["manual", "release"], required: true },
    rating: Number,
    rank,
    reason: { type: String, required: true },
    actorId: ref("User"),
    timestamp: { type: Date, required: true },
    policy: { type: ratingPolicy, required: true },
  },
  options,
);
ratingOverride.index({ pool: 1, timestamp: 1, _id: 1 });
const ratingHistory = new Schema(
  {
    playerId: ref("User"),
    pool: { type: String, enum: ["doubles"], default: "doubles" },
    kind: { type: String, enum: ["match", "override"], required: true },
    matchId: ref("Match", false),
    overrideId: ref("RatingOverride", false),
    previousRating: Number,
    newRating: Number,
    adjustment: Number,
    expectedScore: Number,
    actualScore: Number,
    previousRank: rank,
    newRank: rank,
    ratedMatches: Number,
    kFactor: Number,
    timestamp: { type: Date, required: true },
    reason: String,
    sequence: Number,
  },
  options,
);
ratingHistory.index(
  { playerId: 1, pool: 1, matchId: 1 },
  { unique: true, partialFilterExpression: { kind: "match" } },
);
ratingHistory.index(
  { playerId: 1, pool: 1, overrideId: 1 },
  { unique: true, partialFilterExpression: { kind: "override" } },
);
ratingHistory.index({
  playerId: 1,
  pool: 1,
  timestamp: -1,
  sequence: -1,
  _id: -1,
});
const migration = new Schema(
  { key: { type: String, unique: true }, appliedAt: Date },
  options,
);
export const User = mongoose.model("User", user);
export const Event = mongoose.model("Event", event);
export const EventRegistration = mongoose.model(
  "EventRegistration",
  registration,
);
export const Team = mongoose.model("Team", team);
export const Match = mongoose.model("Match", match);
export const Tournament = mongoose.model("Tournament", tournament);
export const PlayerRankingHistory = mongoose.model(
  "PlayerRankingHistory",
  history,
);
export const Notification = mongoose.model("Notification", notification);
export const AuditLog = mongoose.model("AuditLog", audit);
export const ActionToken = mongoose.model("ActionToken", token);
export const Settings = mongoose.model("Settings", settings);
export const TeamProposal = mongoose.model("TeamProposal", proposal);
export const PlayerRating = mongoose.model("PlayerRating", playerRating);
export const RatingOverride = mongoose.model("RatingOverride", ratingOverride);
export const RatingHistory = mongoose.model("RatingHistory", ratingHistory);
export const Migration = mongoose.model("Migration", migration);
export async function connectDatabase(uri) {
  await mongoose.connect(uri);
  for (const m of Object.values(mongoose.models)) await m.init();
  await Settings.updateOne(
    { key: "global" },
    { $setOnInsert: { key: "global" } },
    { upsert: true },
  );
}
