import { Request, Response } from "express";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { Bank } from "../models/types";

function mapRow(row: any): Bank {
  return {
    id: row.id,
    businessUnit: row.business_unit,
    name: row.name,
    isActive: !!row.is_active,
  };
}

/**
 * "Nama bank" list for the B2B "Buat akun baru" screen's Kas & Bank bank picker --
 * mirrors taxes.controller.ts exactly, editable via the Settings screen instead of a
 * hardcoded frontend list.
 */
export const banksController = {
  async list(req: Request, res: Response) {
    const includeArchived = req.query.includeArchived === "true";
    const activeClause = includeArchived ? "" : "AND is_active = TRUE";
    const [rows] = await pool.query(`SELECT * FROM banks WHERE business_unit = ? ${activeClause} ORDER BY name`, [req.businessUnit]);
    res.json((rows as any[]).map(mapRow));
  },

  async create(req: Request, res: Response) {
    const { name } = req.body;
    if (!name) throw new ApiError(400, "Nama bank wajib diisi");

    const [result] = await pool.query("INSERT INTO banks (business_unit, name) VALUES (?, ?)", [req.businessUnit, name]);
    const insertId = (result as any).insertId;
    const [rows] = await pool.query("SELECT * FROM banks WHERE id = ?", [insertId]);
    res.status(201).json(mapRow((rows as any[])[0]));
  },

  async update(req: Request, res: Response) {
    const { name, isActive } = req.body;
    const [existing] = await pool.query("SELECT * FROM banks WHERE id = ?", [req.params.id]);
    const current = (existing as any[])[0];
    if (!current || current.business_unit !== req.businessUnit) throw new ApiError(404, "Bank tidak ditemukan");

    await pool.query("UPDATE banks SET name = ?, is_active = ? WHERE id = ?", [
      name ?? current.name,
      isActive === undefined ? current.is_active : isActive,
      req.params.id,
    ]);
    const [rows] = await pool.query("SELECT * FROM banks WHERE id = ?", [req.params.id]);
    res.json(mapRow((rows as any[])[0]));
  },
};
