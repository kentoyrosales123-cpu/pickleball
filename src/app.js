import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { api } from "./routes/api.js";
import { errors } from "./middleware/security.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function createApp(config) {
  const app = express();
  app.disable("x-powered-by");
  app.set(
    "trust proxy",
    config.TRUST_PROXY ?? (config.NODE_ENV === "production" ? 1 : false),
  );
  const allowedOrigins = config.ALLOWED_ORIGINS ?? [
    new URL(config.APP_URL).origin,
  ];
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          "script-src": ["'self'"],
          "style-src": ["'self'", "'unsafe-inline'"],
          "img-src": ["'self'", "data:", "https:"],
          "connect-src": ["'self'"],
          "upgrade-insecure-requests":
            config.NODE_ENV === "production" ? [] : null,
        },
      },
    }),
  );
  app.use(cors({ origin: allowedOrigins, credentials: true }));
  app.use(express.json({ limit: "100kb" }), cookieParser());
  app.use(
    "/api",
    rateLimit({
      windowMs: 60_000,
      limit: config.NODE_ENV === "test" ? 10000 : 300,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { message: "Too many requests. Please try again shortly." },
    }),
  );
  app.use("/api", (req, res, next) => {
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      (req.get("X-PMS-Request") !== "1" ||
        (req.get("Origin") && !allowedOrigins.includes(req.get("Origin"))))
    )
      return res.status(403).json({ message: "Request origin rejected" });
    next();
  });
  app.get("/health", (req, res) =>
    res.status(mongoose.connection.readyState === 1 ? 200 : 503).json({
      status: mongoose.connection.readyState === 1 ? "ready" : "unavailable",
    }),
  );
  app.use("/api", api(config));
  app.use("/api", (req, res) =>
    res.status(404).json({ message: "API route not found" }),
  );
  for (const [url, file] of Object.entries({
    "bootstrap.css": "bootstrap/dist/css/bootstrap.min.css",
    "chart.js": "chart.js/dist/chart.umd.js",
    "sweetalert.js": "sweetalert2/dist/sweetalert2.all.min.js",
    "lucide.js": "lucide/dist/umd/lucide.js",
  }))
    app.get(`/vendor/${url}`, (req, res) =>
      res.sendFile(path.join(root, "node_modules", file)),
    );
  app.use(express.static(path.join(root, "public")));
  app.use(errors);
  return app;
}
