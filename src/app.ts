import path from "path";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { env } from "./config/env";
import { apiRouter } from "./routes";
import { errorHandler, notFoundHandler } from "./middlewares/errorHandler";
import { resolveBusinessUnit } from "./middlewares/businessUnit";

export function createApp() {
  const app = express();

  // Served before helmet so product images aren't affected by its default
  // Cross-Origin-Resource-Policy: same-origin header -- the frontend runs on a
  // different origin/port and needs to load these directly in <img> tags.
  app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

  app.use(helmet());
  app.use(cors({ origin: env.corsOrigin }));
  app.use(express.json());
  app.use(morgan(env.nodeEnv === "development" ? "dev" : "combined"));
  app.use(resolveBusinessUnit);

  app.use("/api", apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
