import { Request, Response } from "express";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { Partner } from "../models/types";

function mapRow(row: any): Partner {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    ktpNumber: row.ktp_number,
    phone: row.phone,
    email: row.email,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

/**
 * Find a partner by (ktp + name), or create one. Matching on ktp+name (not ktp alone)
 * avoids collapsing two different drivers who happen to share a KTP typo/duplicate
 * onto the same partner record -- a real case seen in the client's old Odoo import
 * logic (two "Achmad Ridwan"-like drivers).
 */
export async function findOrCreatePartner(name: string, ktpNumber: string | null): Promise<Partner> {
  const cleanName = name.trim();
  if (!cleanName) throw new ApiError(400, "Nama driver wajib diisi");

  if (ktpNumber) {
    const [rows] = await pool.query(
      "SELECT * FROM partners WHERE ktp_number = ? AND name = ?",
      [ktpNumber, cleanName]
    );
    const existing = (rows as any[])[0];
    if (existing) return mapRow(existing);

    const [collision] = await pool.query("SELECT * FROM partners WHERE ktp_number = ?", [ktpNumber]);
    if ((collision as any[])[0]) {
      console.warn(
        `KTP collision: '${ktpNumber}' already belongs to partner '${(collision as any[])[0].name}'. ` +
          `Creating a separate partner for '${cleanName}' -- verify the source data.`
      );
    }
  } else {
    const [rows] = await pool.query("SELECT * FROM partners WHERE ktp_number IS NULL AND name = ?", [cleanName]);
    const existing = (rows as any[])[0];
    if (existing) return mapRow(existing);
  }

  const [result] = await pool.query("INSERT INTO partners (name, ktp_number) VALUES (?, ?)", [
    cleanName,
    ktpNumber,
  ]);
  const insertId = (result as any).insertId;
  const [rows] = await pool.query("SELECT * FROM partners WHERE id = ?", [insertId]);
  return mapRow((rows as any[])[0]);
}

export const partnersController = {
  async list(req: Request, res: Response) {
    const { q, type } = req.query;
    const page = req.query.page ? Number(req.query.page) : 1;
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const clauses: string[] = ["type = ?"];
    const params: unknown[] = [type === "vendor" ? "vendor" : "customer"];
    if (q) {
      clauses.push("(name LIKE ? OR ktp_number LIKE ?)");
      params.push(`%${q}%`, `%${q}%`);
    }
    const where = `WHERE ${clauses.join(" AND ")}`;

    const [countRows] = await pool.query(`SELECT COUNT(*) AS cnt FROM partners ${where}`, params);
    const total = (countRows as any[])[0].cnt as number;

    const [rows] = await pool.query(`SELECT * FROM partners ${where} ORDER BY name LIMIT ? OFFSET ?`, [
      ...params,
      limit,
      (page - 1) * limit,
    ]);
    res.json({ total, page, limit, data: (rows as any[]).map(mapRow) });
  },

  async get(req: Request, res: Response) {
    const [rows] = await pool.query("SELECT * FROM partners WHERE id = ?", [req.params.id]);
    const list = rows as any[];
    if (!list[0]) throw new ApiError(404, "Driver/partner tidak ditemukan");
    res.json(mapRow(list[0]));
  },

  async create(req: Request, res: Response) {
    const { name, type, ktpNumber, phone, email, notes } = req.body;
    if (!name) throw new ApiError(400, "Nama wajib diisi");
    if (ktpNumber && (!/^\d{16}$/.test(ktpNumber))) {
      throw new ApiError(400, "Nomor KTP harus tepat 16 digit angka");
    }

    const [result] = await pool.query(
      "INSERT INTO partners (name, type, ktp_number, phone, email, notes) VALUES (?, ?, ?, ?, ?, ?)",
      [name, type === "vendor" ? "vendor" : "customer", ktpNumber ?? null, phone ?? null, email ?? null, notes ?? null]
    );
    const insertId = (result as any).insertId;
    const [rows] = await pool.query("SELECT * FROM partners WHERE id = ?", [insertId]);
    res.status(201).json(mapRow((rows as any[])[0]));
  },

  async update(req: Request, res: Response) {
    const { name, phone, email, notes } = req.body;
    const [existing] = await pool.query("SELECT * FROM partners WHERE id = ?", [req.params.id]);
    const current = (existing as any[])[0];
    if (!current) throw new ApiError(404, "Driver/partner tidak ditemukan");

    await pool.query("UPDATE partners SET name = ?, phone = ?, email = ?, notes = ? WHERE id = ?", [
      name ?? current.name,
      phone === undefined ? current.phone : phone,
      email === undefined ? current.email : email,
      notes === undefined ? current.notes : notes,
      req.params.id,
    ]);
    const [rows] = await pool.query("SELECT * FROM partners WHERE id = ?", [req.params.id]);
    res.json(mapRow((rows as any[])[0]));
  },
};
