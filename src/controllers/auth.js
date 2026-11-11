import { PlayerRanking } from "../models/ranking.js";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { z } from "zod";
import { User, ActionToken } from "../models/index.js";
import { ensure, publicUser } from "../middleware/security.js";
import { audit } from "../services/notifications.js";
import { sendAction, digest } from "../services/mail.js";
export const password = z
  .string()
  .min(12)
  .max(72)
  .refine(
    (v) => Buffer.byteLength(v) <= 72,
    "Password must be at most 72 UTF-8 bytes",
  );
export const registrationSchema = z
  .object({
    fullName: z.string().trim().min(2).max(100),
    username: z
      .string()
      .regex(/^[a-zA-Z0-9_]{3,30}$/)
      .transform((v) => v.toLowerCase()),
    email: z.email().transform((v) => v.toLowerCase()),
    phone: z
      .string()
      .trim()
      .min(7)
      .max(30)
      .regex(/^[+\d()\s-]+$/),
    password,
    confirmPassword: z.string(),
    provisionalRanking: z.coerce.number().int().min(1).max(12),
    gender: z.string().max(30).optional(),
    dateOfBirth: z.iso.date().optional(),
    profileImage: z.string().max(500).url().startsWith("https://").optional(),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });
export const loginSchema = z.object({
  email: z.email().transform((v) => v.toLowerCase()),
  password: z.string().max(100),
});
export function authController(config) {
  const cookie = {
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
  };
  function sign(res, user) {
    const token = jwt.sign(
      { version: user.tokenVersion || 0 },
      config.JWT_SECRET,
      {
        subject: String(user._id),
        expiresIn: "8h",
        issuer: "pms",
        audience: "pms-web",
      },
    );
    res.cookie("pms_session", token, { ...cookie, maxAge: 8 * 3600_000 });
  }
  const createAccount =
    (adminCreated = false) =>
    async (req, res) => {
      const { password, confirmPassword, ...data } = req.body;
      const passwordHash = await bcrypt.hash(password, 12);
      const user = await mongoose.connection.transaction(async (session) => {
        const [created] = await User.create([{ ...data, passwordHash }], {
          session,
        });
        await PlayerRanking.create([{ userId: created._id }], { session });
        if (adminCreated)
          await audit(
            req.user._id,
            "create-user",
            "User",
            created._id,
            null,
            {
              fullName: created.fullName,
              username: created.username,
              email: created.email,
              role: created.role,
            },
            session,
          );
        return created;
      });
      if (!adminCreated) sign(res, user);
      let emailSent = Boolean(config.SMTP_HOST);
      try {
        await sendAction(user, "verify", config);
      } catch {
        emailSent = false;
      }
      res.status(201).json({ user: publicUser(user), emailSent });
    };
  return {
    register: createAccount(),
    createUser: createAccount(true),
    login: async (req, res) => {
      const user = await User.findOne({ email: req.body.email }).select(
        "+passwordHash +tokenVersion",
      );
      const valid = await bcrypt.compare(
        req.body.password,
        user?.passwordHash ||
          "$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxV.PMjHthgOs9Uqt9w55S3JTSG",
      );
      ensure(valid && user?.active, "Invalid email or password", 401);
      sign(res, user);
      res.json({ user: publicUser(user) });
    },
    logout: async (req, res) => {
      await User.updateOne(
        { _id: req.user._id },
        { $inc: { tokenVersion: 1 } },
      );
      res.clearCookie("pms_session", cookie).json({ message: "Signed out" });
    },
    me: (req, res) => res.json({ user: publicUser(req.user) }),
    forgot: async (req, res) => {
      const user = await User.findOne({ email: req.body.email });
      if (user) {
        try {
          await sendAction(user, "reset", config);
        } catch {
          console.error("Password-reset email delivery failed");
        }
      }
      res.json({
        message: "If that account exists, a reset link has been sent.",
      });
    },
    resend: async (req, res) => {
      if (!req.user.emailVerified) await sendAction(req.user, "verify", config);
      res.json({ message: "Verification link requested." });
    },
    consume: async (req, res) => {
      const { token, purpose, password: newPassword } = req.body;
      const hash = newPassword ? await bcrypt.hash(newPassword, 12) : null;
      await mongoose.connection.transaction(async (session) => {
        const action = await ActionToken.findOneAndDelete(
          { hash: digest(token), purpose, expiresAt: { $gt: new Date() } },
          { session },
        );
        ensure(action, "Link is invalid or expired");
        await User.updateOne(
          { _id: action.userId },
          purpose === "verify"
            ? { emailVerified: true }
            : { $set: { passwordHash: hash }, $inc: { tokenVersion: 1 } },
          { session },
        );
        if (purpose === "reset")
          await ActionToken.deleteMany(
            { userId: action.userId, purpose },
            { session },
          );
      });
      res.json({
        message:
          purpose === "verify"
            ? "Email verified"
            : "Password updated. Please sign in.",
      });
    },
  };
}
