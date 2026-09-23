import { randomUUID } from "crypto";
import { Request, Response } from "express";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { PublicUser, User } from "../models/types";
import { zarveLogin, zarveGoogleLogin, setZarveApiToken, ZarveLoginUser } from "../utils/zarveApiClient";

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

async function findUserByEmail(email: string): Promise<User | undefined> {
  const [rows] = await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE email = ?`, [email]);
  const list = rows as User[];
  return list[0];
}

export async function findUserById(id: number): Promise<User | undefined> {
  const [rows] = await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, [id]);
  const list = rows as User[];
  return list[0];
}

// Links a registered user row to the Zarve account that just authenticated for it,
// refreshing its name from Zarve. The password itself is never stored -- it's verified
// against Zarve fresh on every login. A stale link on another row (e.g. the Zarve
// account's email changed) is cleared first so the UNIQUE zarve_user_id never collides.
async function linkZarveUser(user: User, zu: ZarveLoginUser): Promise<User> {
  await pool.query("UPDATE users SET zarve_user_id = NULL WHERE zarve_user_id = ? AND id <> ?", [zu.id, user.id]);
  await pool.query("UPDATE users SET zarve_user_id = ?, name = ? WHERE id = ?", [zu.id, zu.name || user.name, user.id]);
  const linked = await findUserById(user.id);
  if (!linked) throw new ApiError(500, "Gagal membuat sesi user dari akun Zarve");
  return linked;
}

function issueSession(res: Response, user: User) {
  const token = randomUUID();
  sessionStore.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS });
  res.json({ token, user: toPublicUser(user) });
}

const NO_ACCESS_MESSAGE = "Email tidak memiliki akses ke RVE Finance. Hubungi admin untuk didaftarkan.";

// Access list: only emails an admin registered on the Users page may log in, even if
// they're a valid Zarve account.
async function requireRegistered(email: string): Promise<User> {
  const registered = await findUserByEmail(email.trim().toLowerCase());
  if (!registered || !registered.aktif) throw new ApiError(403, NO_ACCESS_MESSAGE);
  return registered;
}

// Reads the email claim out of a Firebase ID token WITHOUT verifying it -- only used to
// run the access-list check before bothering Zarve. The token is verified by Zarve, and
// the email Zarve returns is re-checked afterwards, so a forged claim gains nothing.
function unverifiedTokenEmail(idToken: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.email === "string" ? payload.email : undefined;
  } catch {
    return undefined;
  }
}

// Common tail of both login flows once Zarve has accepted the credentials. The token
// Zarve hands back is also captured as the one used for background mirror sync (see
// zarveApiClient.ts), so it refreshes on every login instead of needing a hand-copied
// .env value.
async function completeZarveLogin(res: Response, registered: User, zu: ZarveLoginUser, zarveToken: string) {
  if (zu.isSuspended || zu.isActive === false) throw new ApiError(403, "Akun Zarve tidak aktif/di-suspend");
  if (zu.email.trim().toLowerCase() !== registered.email.toLowerCase()) throw new ApiError(403, NO_ACCESS_MESSAGE);

  await setZarveApiToken(zarveToken);
  const user = await linkZarveUser(registered, zu);
  issueSession(res, user);
}

export const authController = {
  // Every login goes through Zarve's own account system -- no local password.
  async login(req: Request, res: Response) {
    const { email, password } = req.body;
    if (!email || !password) throw new ApiError(400, "Email dan password wajib diisi");

    const registered = await requireRegistered(String(email));
    const result = await zarveLogin(String(email).trim(), String(password));
    if (!result) throw new ApiError(401, "Email atau password salah");
    await completeZarveLogin(res, registered, result.user, result.token);
  },

  async googleLogin(req: Request, res: Response) {
    const { idToken } = req.body;
    if (!idToken || typeof idToken !== "string") throw new ApiError(400, "Token Google wajib diisi");

    const email = unverifiedTokenEmail(idToken);
    if (!email) throw new ApiError(400, "Token Google tidak valid");
    const registered = await requireRegistered(email);

    const result = await zarveGoogleLogin(idToken);
    if (!result) throw new ApiError(401, "Akun Google ini tidak terdaftar di Zarve");
    await completeZarveLogin(res, registered, result.user, result.token);
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
