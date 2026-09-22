import { Request, Response } from "express";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { Account, AccountType } from "../models/types";

const ACCOUNT_TYPES: AccountType[] = ["asset", "liability", "equity", "income", "expense"];

function mapRow(row: any): Account {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    parentId: row.parent_id,
    isActive: !!row.is_active,
  };
}

export const accountsController = {
  async list(req: Request, res: Response) {
    const { type } = req.query;
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (type) {
      clauses.push("type = ?");
      params.push(type);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const [rows] = await pool.query(`SELECT * FROM accounts ${where} ORDER BY code`, params);
    res.json((rows as any[]).map(mapRow));
  },

  async get(req: Request, res: Response) {
    const [rows] = await pool.query("SELECT * FROM accounts WHERE id = ?", [req.params.id]);
    const list = rows as any[];
    if (!list[0]) throw new ApiError(404, "Akun tidak ditemukan");
    res.json(mapRow(list[0]));
  },

  async create(req: Request, res: Response) {
    const { code, name, type, parentId } = req.body;
    if (!code || !name || !type) throw new ApiError(400, "Kode, nama, dan tipe akun wajib diisi");
    if (!ACCOUNT_TYPES.includes(type)) throw new ApiError(400, `Tipe akun harus salah satu dari: ${ACCOUNT_TYPES.join(", ")}`);

    const [result] = await pool.query(
      "INSERT INTO accounts (code, name, type, parent_id) VALUES (?, ?, ?, ?)",
      [code, name, type, parentId ?? null]
    );
    const insertId = (result as any).insertId;
    const [rows] = await pool.query("SELECT * FROM accounts WHERE id = ?", [insertId]);
    res.status(201).json(mapRow((rows as any[])[0]));
  },

  async update(req: Request, res: Response) {
    const { name, isActive, parentId } = req.body;
    const [existing] = await pool.query("SELECT * FROM accounts WHERE id = ?", [req.params.id]);
    const current = (existing as any[])[0];
    if (!current) throw new ApiError(404, "Akun tidak ditemukan");

    await pool.query("UPDATE accounts SET name = ?, is_active = ?, parent_id = ? WHERE id = ?", [
      name ?? current.name,
      isActive === undefined ? current.is_active : isActive,
      parentId === undefined ? current.parent_id : parentId,
      req.params.id,
    ]);
    const [rows] = await pool.query("SELECT * FROM accounts WHERE id = ?", [req.params.id]);
    res.json(mapRow((rows as any[])[0]));
  },
};
