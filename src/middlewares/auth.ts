import { NextFunction, Request, Response } from "express";
import { ApiError } from "./errorHandler";
import { resolveSession, findUserById } from "../controllers/auth.controller";
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

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const session = resolveSession(extractToken(req));
  if (!session) throw new ApiError(401, "Belum login");
  const user = await findUserById(session.userId);
  if (!user || !user.aktif) throw new ApiError(401, "Belum login");
  const { passwordHash: _passwordHash, ...publicUser } = user;
  req.authUser = publicUser;
  next();
}
