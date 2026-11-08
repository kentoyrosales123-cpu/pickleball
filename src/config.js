import "dotenv/config";
import { z } from "zod";
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_URL: z.url().default("http://localhost:3000"),
  MONGODB_URI: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().optional(),
});
export function getConfig(env = process.env) {
  const onRender = env.RENDER === "true";
  const renderUrl = onRender ? env.RENDER_EXTERNAL_URL : undefined;
  const result = schema.safeParse({
    ...env,
    APP_URL: env.APP_URL?.trim() || renderUrl || "http://localhost:3000",
  });
  if (!result.success)
    throw new Error(
      `Invalid configuration: ${result.error.issues.map((i) => i.path.join(".")).join(", ")}. Set these values in .env (not .env.example). MONGODB_URI must point to Atlas or a MongoDB replica set; JWT_SECRET must contain at least 32 characters. For a disposable local database, run npm run preview.`,
    );
  const c = result.data;
  const appUrl = new URL(c.APP_URL);
  if (!["http:", "https:"].includes(appUrl.protocol))
    throw new Error("APP_URL must use HTTP or HTTPS");
  c.APP_URL = appUrl.origin;
  c.TRUST_PROXY = onRender || c.NODE_ENV === "production" ? 1 : false;
  c.ALLOWED_ORIGINS = [c.APP_URL];
  if (renderUrl) {
    const renderOrigin = new URL(renderUrl).origin;
    if (appUrl.hostname === "localhost" || appUrl.hostname === "127.0.0.1") {
      c.APP_URL = renderOrigin;
      c.ALLOWED_ORIGINS = [renderOrigin];
    } else if (!c.ALLOWED_ORIGINS.includes(renderOrigin)) {
      c.ALLOWED_ORIGINS.push(renderOrigin);
    }
  }
  if (
    c.NODE_ENV === "production" &&
    (!c.APP_URL.startsWith("https://") || !c.SMTP_HOST || !c.MAIL_FROM)
  )
    throw new Error("Production requires HTTPS APP_URL and SMTP configuration");
  return c;
}
