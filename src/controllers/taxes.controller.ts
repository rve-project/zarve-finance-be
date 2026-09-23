import { Request, Response } from "express";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { TaxCode } from "../models/types";

function mapRow(row: any): TaxCode {
  return {
    id: row.id,
    businessUnit: row.business_unit,
    name: row.name,
    rate: Number(row.rate),
    isActive: !!row.is_active,
  };
}

/**
 * Tax codes (e.g. "PPN 11%") for the B2B "Daftar Akun" create form's Pajak dropdown --
 * previously a dead, disabled placeholder since no tax concept existed at all.
 */
export const taxesController = {
  async list(req: Request, res: Response) {
    const includeArchived = req.query.includeArchived === "true";
    const activeClause = includeArchived ? "" : "AND is_active = TRUE";
    const [rows] = await pool.query(`SELECT * FROM taxes WHERE business_unit = ? ${activeClause} ORDER BY name`, [req.businessUnit]);
    res.json((rows as any[]).map(mapRow));
  },

  async create(req: Request, res: Response) {
    const { name, rate } = req.body;
    if (!name || rate === undefined || rate === null || rate === "") throw new ApiError(400, "Nama dan tarif pajak wajib diisi");
    if (Number.isNaN(Number(rate)) || Number(rate) < 0) throw new ApiError(400, "Tarif pajak harus berupa angka >= 0");

    const [result] = await pool.query("INSERT INTO taxes (business_unit, name, rate) VALUES (?, ?, ?)", [
      req.businessUnit,
      name,
      rate,
    ]);
    const insertId = (result as any).insertId;
    const [rows] = await pool.query("SELECT * FROM taxes WHERE id = ?", [insertId]);
    res.status(201).json(mapRow((rows as any[])[0]));
  },

  async update(req: Request, res: Response) {
    const { name, rate, isActive } = req.body;
    const [existing] = await pool.query("SELECT * FROM taxes WHERE id = ?", [req.params.id]);
    const current = (existing as any[])[0];
    if (!current || current.business_unit !== req.businessUnit) throw new ApiError(404, "Pajak tidak ditemukan");

    await pool.query("UPDATE taxes SET name = ?, rate = ?, is_active = ? WHERE id = ?", [
      name ?? current.name,
      rate === undefined ? current.rate : rate,
      isActive === undefined ? current.is_active : isActive,
      req.params.id,
    ]);
    const [rows] = await pool.query("SELECT * FROM taxes WHERE id = ?", [req.params.id]);
    res.json(mapRow((rows as any[])[0]));
  },
};
