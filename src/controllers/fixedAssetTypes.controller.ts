import { Request, Response } from "express";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { FixedAssetType } from "../models/types";

function mapRow(row: any): FixedAssetType {
  return {
    id: row.id,
    businessUnit: row.business_unit,
    name: row.name,
    requiresPlateNumber: !!row.requires_plate_number,
    isActive: !!row.is_active,
  };
}

/**
 * "Jenis Aset" (e.g. "Umum", "Kendaraan Operasional") for the fixed-asset create form's
 * type picker -- mirrors payment_terms.controller.ts exactly, editable via Settings
 * instead of a hardcoded 2-value list. `requiresPlateNumber` drives the create form's
 * "plate number is mandatory" validation -- see migration 056_fixed_asset_types.sql.
 */
export const fixedAssetTypesController = {
  async list(req: Request, res: Response) {
    const includeArchived = req.query.includeArchived === "true";
    const activeClause = includeArchived ? "" : "AND is_active = TRUE";
    const [rows] = await pool.query(`SELECT * FROM fixed_asset_types WHERE business_unit = ? ${activeClause} ORDER BY name`, [
      req.businessUnit,
    ]);
    res.json((rows as any[]).map(mapRow));
  },

  async create(req: Request, res: Response) {
    const { name, requiresPlateNumber } = req.body;
    if (!name) throw new ApiError(400, "Nama jenis aset wajib diisi");

    const [result] = await pool.query("INSERT INTO fixed_asset_types (business_unit, name, requires_plate_number) VALUES (?, ?, ?)", [
      req.businessUnit,
      name,
      !!requiresPlateNumber,
    ]);
    const insertId = (result as any).insertId;
    const [rows] = await pool.query("SELECT * FROM fixed_asset_types WHERE id = ?", [insertId]);
    res.status(201).json(mapRow((rows as any[])[0]));
  },

  async update(req: Request, res: Response) {
    const { name, requiresPlateNumber, isActive } = req.body;
    const [existing] = await pool.query("SELECT * FROM fixed_asset_types WHERE id = ?", [req.params.id]);
    const current = (existing as any[])[0];
    if (!current || current.business_unit !== req.businessUnit) throw new ApiError(404, "Jenis aset tidak ditemukan");

    await pool.query("UPDATE fixed_asset_types SET name = ?, requires_plate_number = ?, is_active = ? WHERE id = ?", [
      name ?? current.name,
      requiresPlateNumber === undefined ? current.requires_plate_number : !!requiresPlateNumber,
      isActive === undefined ? current.is_active : isActive,
      req.params.id,
    ]);
    const [rows] = await pool.query("SELECT * FROM fixed_asset_types WHERE id = ?", [req.params.id]);
    res.json(mapRow((rows as any[])[0]));
  },
};
