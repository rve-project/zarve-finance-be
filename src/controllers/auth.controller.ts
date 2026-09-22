import { randomUUID } from "crypto";
import { Request, Response } from "express";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { PublicUser, User } from "../models/types";
import { zarveLogin, setZarveApiToken, ZarveLoginUser } from "../utils/zarveApiClient";

interface Session {
  userId: number;
  expiresAt: number;
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const sessionStore = new Map<string, Session>();

export function resolveSession(token: string | undefined) {
  if (!token) return undefined;
  const session = sessionStore.get(token);
  if (!session) return undefined;
  if (session.expiresAt < Date.now()) {
    sessionStore.delete(token);
    return undefined;
  }
  return session;
}

function toPublicUser(user: User): PublicUser {
  const { passwordHash: _passwordHash, ...rest } = user;
  return rest;
}

const USER_COLUMNS = "id, email, name, password_hash AS passwordHash, zarve_user_id AS zarveUserId, role, aktif";

async function findUserByZarveId(zarveUserId: string): Promise<User | undefined> {
  const [rows] = await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE zarve_user_id = ?`, [zarveUserId]);
  const list = rows as User[];
  return list[0];
}

export async function findUserById(id: number): Promise<User | undefined> {
  const [rows] = await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, [id]);
  const list = rows as User[];
  return list[0];
}

// Mirrors a Zarve account into our local `users` table on successful Zarve login --
// gives it a local numeric id/session like any other user, without ever storing its
// password (verified against Zarve fresh on every login instead).
async function upsertZarveUser(zu: ZarveLoginUser): Promise<User> {
  await pool.query(
    `INSERT INTO users (email, name, password_hash, role, aktif, zarve_user_id)
     VALUES (?, ?, NULL, 'admin', TRUE, ?)
     ON DUPLICATE KEY UPDATE name = VALUES(name), aktif = TRUE`,
    [zu.email.toLowerCase(), zu.name, zu.id]
  );
  const user = await findUserByZarveId(zu.id);
  if (!user) throw new ApiError(500, "Gagal membuat sesi user dari akun Zarve");
  return user;
}

function issueSession(res: Response, user: User) {
  const token = randomUUID();
  sessionStore.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS });
  res.json({ token, user: toPublicUser(user) });
}

export const authController = {
  async login(req: Request, res: Response) {
    const { email, password } = req.body;
    if (!email || !password) throw new ApiError(400, "Email dan password wajib diisi");

    // Every login goes through Zarve's own account system -- no local password. The
    // token Zarve hands back is also captured as the one used for background mirror
    // sync (see zarveApiClient.ts), so it refreshes on every login instead of needing
    // a hand-copied .env value.
    const result = await zarveLogin(String(email), String(password));
    if (!result) throw new ApiError(401, "Email atau password salah");
    if (result.user.isSuspended || result.user.isActive === false) {
      throw new ApiError(403, "Akun Zarve tidak aktif/di-suspend");
    }

    await setZarveApiToken(result.token);

    const user = await upsertZarveUser(result.user);
    if (!user.aktif) throw new ApiError(403, "Akun tidak aktif");
    issueSession(res, user);
  },

  logout(req: Request, res: Response) {
    const auth = req.headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    if (token) sessionStore.delete(token);
    res.status(204).send();
  },

  async me(req: Request, res: Response) {
    if (!req.authUser) throw new ApiError(401, "Belum login");
    res.json(req.authUser);
  },
};
