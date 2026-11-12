import jwt from "jsonwebtoken";
import { User } from "../models/index.js";
import { numericalRating } from "../domain/ratings.js";
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const ensure = (condition, message, status = 400) => {
  if (!condition) throw new HttpError(status, message);
};
export const validate = (schema) => (req, res, next) => {
  const r = schema.safeParse(req.body);
  if (!r.success)
    return res.status(400).json({
      message: r.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; "),
    });
  req.body = r.data;
  next();
};
export async function identify(token, config) {
  let data;
  try {
    data = jwt.verify(token || "", config.JWT_SECRET, {
      algorithms: ["HS256"],
      issuer: "pms",
      audience: "pms-web",
    });
  } catch {
    throw new HttpError(401, "Please sign in");
  }
  const user = await User.findById(data.sub).select("+tokenVersion");
  ensure(
    user && user.active && user.tokenVersion === data.version,
    "Session expired. Please sign in.",
    401,
  );
  return user;
}
export const auth = (config) => async (req, res, next) => {
  req.user = await identify(req.cookies.pms_session, config);
  next();
};
export const admin = (req, res, next) => {
  ensure(
    ["admin", "super-admin"].includes(req.user.role),
    "Administrator access required",
    403,
  );
  next();
};
export const superAdmin = (req, res, next) => {
  ensure(req.user.role === "super-admin", "Super Admin access required", 403);
  next();
};
export const publicUser = (u) => ({
  id: String(u._id),
  fullName: u.fullName,
  username: u.username,
  email: u.email,
  phone: u.phone,
  role: u.role,
  profileImage: u.profileImage,
  gender: u.gender,
  dateOfBirth: u.dateOfBirth,
  provisionalRanking: u.provisionalRanking,
  officialRanking: u.officialRanking,
  rankingStatus: u.rankingStatus,
  emailVerified: u.emailVerified,
  doublesRating: numericalRating(u),
  doublesRatedMatches: u.doublesRatedMatches || 0,
  automaticRanking:
    u.automaticRanking || u.officialRanking || u.provisionalRanking,
  automaticRankingStatus: u.automaticRankingStatus || "provisional",
  rankingOverride: u.rankingOverride || false,
});
export function errors(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status =
    err.status ||
    (err.code === 11000
      ? 409
      : ["ValidationError", "CastError", "StrictModeError"].includes(err.name)
        ? 400
        : 500);
  if (status === 500) console.error(err);
  res.status(status).json({
    message:
      err.code === 11000
        ? "That record already exists"
        : status === 500
          ? "Unexpected server error"
          : err.message,
  });
}
