import { Request, Response } from "express";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { ManagedUser } from "../models/types";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function mapRow(row: any): ManagedUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    aktif: Boolean(row.aktif),
    zarveUserId: row.zarve_user_id,
    createdAt: row.created_at,
  };
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

    // Name is optional -- it gets refreshed from the Zarve account on first login.
    const [result] = await pool.query(
      "INSERT INTO users (email, name, password_hash, role, aktif) VALUES (?, ?, NULL, 'admin', TRUE)",
      [email, name || email.split("@")[0]]
    );
    res.status(201).json(mapRow(await findRow((result as any).insertId)));
  },

  async update(req: Request, res: Response) {
    const current = await findRow(req.params.id);
    if (!current) throw new ApiError(404, "User tidak ditemukan");

    const { name, aktif } = req.body;
    if (aktif === false && current.aktif) {
      if (current.id === req.authUser!.id) throw new ApiError(400, "Tidak bisa menonaktifkan akun sendiri");
      if ((await countOtherActiveUsers(current.id)) === 0) throw new ApiError(400, "Minimal harus ada satu user aktif");
    }

    await pool.query("UPDATE users SET name = ?, aktif = ? WHERE id = ?", [
      typeof name === "string" && name.trim() ? name.trim() : current.name,
      typeof aktif === "boolean" ? aktif : Boolean(current.aktif),
      current.id,
    ]);
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
