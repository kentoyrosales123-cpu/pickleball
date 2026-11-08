import mongoose from "mongoose";
import { initialRanking, RULES } from "../domain/ranking.js";
const { Schema } = mongoose;
const ref = (model) => ({
  type: Schema.Types.ObjectId,
  ref: model,
  required: true,
});
const options = { timestamps: true, strict: "throw" };
const profile = new Schema(
  {
    userId: { ...ref("User"), unique: true },
    state: { type: Schema.Types.Mixed, default: initialRanking },
    version: { type: Number, default: 0 },
  },
  options,
);
profile.index({
  "state.rankStars": -1,
  "state.mmr": -1,
  "state.totalWins": -1,
  userId: 1,
});
const history = new Schema(
  {
    playerId: ref("User"),
    sourceId: { type: String, required: true },
    matchId: { type: Schema.Types.ObjectId, ref: "Match" },
    eventId: { type: Schema.Types.ObjectId, ref: "Event" },
    seasonId: {
      type: Schema.Types.ObjectId,
      ref: "RankingSeason",
      default: null,
    },
    kind: { type: String, enum: ["match", "adjustment"] },
    timestamp: Date,
    before: Schema.Types.Mixed,
    after: Schema.Types.Mixed,
    won: Boolean,
    starsChanged: Number,
    mmrChanged: Number,
    protectionActivated: Boolean,
    doubleStarActivated: Boolean,
    rankPromoted: Boolean,
    rankDemoted: Boolean,
    kFactor: Number,
    expectedScore: Number,
    reason: String,
  },
  options,
);
history.index({ playerId: 1, sourceId: 1 }, { unique: true });
history.index({ seasonId: 1, timestamp: -1, playerId: 1 });
history.index({ playerId: 1, timestamp: -1 });
const season = new Schema(
  {
    name: { type: String, required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    status: { type: String, enum: ["active", "closed"], required: true },
    resetPolicy: {
      type: String,
      enum: ["none", "partial", "placement"],
      default: "none",
    },
    keepFraction: { type: Number, min: 0, max: 1, default: 0.5 },
    rankingRules: { type: Schema.Types.Mixed, default: () => ({ ...RULES }) },
  },
  options,
);
season.index(
  { status: 1 },
  { unique: true, partialFilterExpression: { status: "active" } },
);
const snapshot = new Schema(
  {
    playerId: ref("User"),
    seasonId: ref("RankingSeason"),
    state: Schema.Types.Mixed,
  },
  options,
);
snapshot.index({ playerId: 1, seasonId: 1 }, { unique: true });
const adjustment = new Schema(
  {
    playerId: ref("User"),
    actorId: ref("User"),
    rankStars: {
      type: Number,
      min: 0,
      required: true,
      validate: Number.isSafeInteger,
    },
    reason: { type: String, required: true },
    externalReview: {
      type: new Schema(
        {
          source: { type: String, enum: ["pickle-que"], required: true },
          entryMethod: {
            type: String,
            enum: ["admin-entered"],
            required: true,
          },
          profileUrl: { type: String, required: true, maxlength: 1000 },
          accountName: { type: String, required: true, maxlength: 100 },
          observedOn: { type: String, required: true },
          wins: {
            type: Number,
            min: 0,
            required: true,
            validate: Number.isSafeInteger,
          },
          losses: {
            type: Number,
            min: 0,
            required: true,
            validate: Number.isSafeInteger,
          },
          matches: { type: Number, min: 1, required: true },
          winPercentage: { type: Number, min: 0, max: 100, required: true },
          displayedRating: { type: String, maxlength: 100 },
          notes: { type: String, maxlength: 1000 },
          previousRankStars: { type: Number, min: 0, required: true },
        },
        { _id: false, versionKey: false, strict: "throw" },
      ),
      default: undefined,
    },
    timestamp: { type: Date, default: Date.now },
  },
  options,
);
export const PlayerRanking = mongoose.model("PlayerRanking", profile);
export const RankingHistory = mongoose.model("RankingHistory", history);
export const RankingSeason = mongoose.model("RankingSeason", season);
export const SeasonRanking = mongoose.model("SeasonRanking", snapshot);
export const RankingAdjustment = mongoose.model(
  "RankingAdjustment",
  adjustment,
);
