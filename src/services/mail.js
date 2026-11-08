import crypto from "node:crypto";
import nodemailer from "nodemailer";
import { ActionToken } from "../models/index.js";
export const digest = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");
export async function sendAction(user, purpose, config) {
  const raw = crypto.randomBytes(32).toString("hex");
  await ActionToken.create({
    userId: user._id,
    hash: digest(raw),
    purpose,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const url = `${config.APP_URL}/?action=${purpose}#token=${raw}`;
  if (!config.SMTP_HOST) {
    if (config.NODE_ENV === "development")
      console.info(`Development ${purpose} link: ${url}`);
    return;
  }
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    auth: config.SMTP_USER
      ? { user: config.SMTP_USER, pass: config.SMTP_PASS }
      : undefined,
  });
  await transport.sendMail({
    from: config.MAIL_FROM,
    to: user.email,
    subject:
      purpose === "verify"
        ? "Verify your CourtSide account"
        : "Reset your CourtSide password",
    text: `Open this link within one hour: ${url}`,
  });
}
