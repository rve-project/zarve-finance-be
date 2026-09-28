import { Request, Response } from "express";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { ManagedUser } from "../models/types";
import { hashPassword } from "../utils/password";
import { MODULE_KEYS } from "../config/modules";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function mapRow(row: any): ManagedUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    aktif: Boolean(row.aktif),
    canViewActivityLog: Boolean(row.can_view_activity_log),
    zarveUserId: row.zarve_user_id,
    allowedModules: row.allowed_modules ?? null,
    hasLocalPassword: Boolean(row.password_hash),
    createdAt: row.created_at,
  };
}

function parseAllowedModules(value: unknown): string[] | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!Array.isArray(value)) throw new ApiError(400, "allowedModules harus berupa array");
  const strings = value.map((v) => String(v));
  const validKeys: readonly string[] = MODULE_KEYS;
  const invalid = strings.filter((v) => !validKeys.includes(v));
  if (invalid.length > 0) throw new ApiError(400, `Modul tidak valid: ${invalid.join(", ")}`);
  return Array.from(new Set(strings));
}

async function findRow(id: unknown) {
  const [rows] = await pool.query("SELECT * FROM users WHERE id = ?", [id]);
  return (rows as any[])[0];
}

async function countOtherActiveUsers(excludeId: number): Promise<number> {
  const [rows] = await pool.query("SELECT COUNT(*) AS n FROM users WHERE aktif = TRUE AND id <> ?", [excludeId]);
  return (rows as any[])[0].n;
}

// Users here are the access list for logging in -- the password itself always lives in
// Zarve. Registering an email is what grants a Zarve account access to rve-finance.
export const usersController = {
  async list(_req: Request, res: Response) {
    const [rows] = await pool.query("SELECT * FROM users ORDER BY name, email");
    res.json((rows as any[]).map(mapRow));
  },

  async create(req: Request, res: Response) {
    const email = String(req.body.email ?? "").trim().toLowerCase();
    const name = String(req.body.name ?? "").trim();
    if (!EMAIL_PATTERN.test(email)) throw new ApiError(400, "Email tidak valid");

    const [existing] = await pool.query("SELECT id FROM users WHERE email = ?", [email]);
    if ((existing as any[])[0]) throw new ApiError(409, "Email sudah terdaftar");

    // Password is optional: leave it out for a Zarve-linked account (the original
    // design -- this email must also be a valid Zarve account, and Zarve verifies the
    // password on every login). Set one to create a fully local account instead, for
    // someone with no Zarve account at all -- login() checks it directly, no Zarve
    // dependency.
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const passwordHash = password ? hashPassword(password) : null;
    const allowedModules = parseAllowedModules(req.body.allowedModules) ?? null;

    // Name is optional -- it gets refreshed from the Zarve account on first login (for
    // Zarve-linked accounts only; a local account keeps whatever name was set here).
    const [result] = await pool.query(
      "INSERT INTO users (email, name, password_hash, role, aktif, allowed_modules) VALUES (?, ?, ?, 'admin', TRUE, ?)",
      [email, name || email.split("@")[0], passwordHash, allowedModules ? JSON.stringify(allowedModules) : null]
    );
    res.status(201).json(mapRow(await findRow((result as any).insertId)));
  },

  async update(req: Request, res: Response) {
    const current = await findRow(req.params.id);
    if (!current) throw new ApiError(404, "User tidak ditemukan");

    const { name, aktif, canViewActivityLog, password } = req.body;
    if (aktif === false && current.aktif) {
      if (current.id === req.authUser!.id) throw new ApiError(400, "Tidak bisa menonaktifkan akun sendiri");
      if ((await countOtherActiveUsers(current.id)) === 0) throw new ApiError(400, "Minimal harus ada satu user aktif");
    }

    const allowedModules = parseAllowedModules(req.body.allowedModules);
    const passwordHash = typeof password === "string" && password ? hashPassword(password) : undefined;

    await pool.query(
      `UPDATE users SET name = ?, aktif = ?, can_view_activity_log = ?, allowed_modules = ?
       ${passwordHash !== undefined ? ", password_hash = ?" : ""}
       WHERE id = ?`,
      [
        typeof name === "string" && name.trim() ? name.trim() : current.name,
        typeof aktif === "boolean" ? aktif : Boolean(current.aktif),
        typeof canViewActivityLog === "boolean" ? canViewActivityLog : Boolean(current.can_view_activity_log),
        allowedModules === undefined
          ? current.allowed_modules
            ? JSON.stringify(current.allowed_modules)
            : null
          : allowedModules === null
            ? null
            : JSON.stringify(allowedModules),
        ...(passwordHash !== undefined ? [passwordHash] : []),
        current.id,
      ]
    );
    res.json(mapRow(await findRow(current.id)));
  },

  async remove(req: Request, res: Response) {
    const current = await findRow(req.params.id);
    if (!current) throw new ApiError(404, "User tidak ditemukan");
    if (current.id === req.authUser!.id) throw new ApiError(400, "Tidak bisa menghapus akun sendiri");
    if (current.aktif && (await countOtherActiveUsers(current.id)) === 0) {
      throw new ApiError(400, "Minimal harus ada satu user aktif");
    }

    // Any open session for this user dies on its next request: requireAuth re-reads the
    // row every time and rejects when it's gone.
    await pool.query("DELETE FROM users WHERE id = ?", [current.id]);
    res.status(204).send();
  },
};
