import dotenv from "dotenv";

dotenv.config();

export const env = {
  port: Number(process.env.PORT) || 4001,
  nodeEnv: process.env.NODE_ENV || "development",
  // Dev-only convenience: skips real login entirely so tsx watch restarts (which wipe
  // the in-memory session store) don't force a fresh Zarve login every time. Requires
  // NODE_ENV=development on top of the flag itself, so it can never activate by
  // accident on staging/production even if the flag leaks into an env file there.
  disableAuthForDev: process.env.DISABLE_AUTH_FOR_DEV === "true" && (process.env.NODE_ENV || "development") === "development",
  corsOrigin: (process.env.CORS_ORIGIN || "http://localhost:3001")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  mysql: {
    host: process.env.MYSQL_HOST || "localhost",
    port: Number(process.env.MYSQL_PORT) || 3307,
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "rve_finance",
  },
  zarveApi: {
    baseUrl: process.env.ZARVE_API_URL || "",
  },
};
