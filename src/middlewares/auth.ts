import { NextFunction, Request, Response } from "express";
import { ApiError } from "./errorHandler";
import { resolveSession, findUserById } from "../controllers/auth.controller";
import { env } from "../config/env";
import { pool } from "../db";
import { PublicUser } from "../models/types";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authUser?: PublicUser;
    }
  }
}

function extractToken(req: Request): string | undefined {
  const auth = req.headers.authorization;
  return auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
}

// DISABLE_AUTH_FOR_DEV support: picks DEV_USER_EMAIL if set, else the first active
// user, and caches it -- avoids a DB round trip on every request while still picking
// up a change if the dev server restarts (module-level cache, not persisted).
let cachedDevUser: PublicUser | undefined;

async function loadDevUser(): Promise<PublicUser> {
  if (cachedDevUser) return cachedDevUser;
  const email = process.env.DEV_USER_EMAIL;
  const [rows] = await pool.query(
    `SELECT id, email, name, zarve_user_id AS zarveUserId, role, aktif
     FROM users WHERE aktif = TRUE ${email ? "AND email = ?" : ""} ORDER BY id LIMIT 1`,
    email ? [email] : []
  );
  const user = (rows as PublicUser[])[0];
  if (!user) {
    throw new ApiError(
      500,
      "DISABLE_AUTH_FOR_DEV aktif tapi tidak ada user aktif ditemukan di tabel users (cek DEV_USER_EMAIL kalau di-set)."
    );
  }
  cachedDevUser = user;
  return user;
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (env.disableAuthForDev) {
    req.authUser = await loadDevUser();
    return next();
  }

  const session = resolveSession(extractToken(req));
  if (!session) throw new ApiError(401, "Belum login");
  const user = await findUserById(session.userId);
  if (!user || !user.aktif) throw new ApiError(401, "Belum login");
  const { passwordHash: _passwordHash, ...publicUser } = user;
  req.authUser = publicUser;
  next();
}
