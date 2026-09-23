import { Request, Response } from "express";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { AccountCategory, AccountType } from "../models/types";

const ACCOUNT_TYPES: AccountType[] = ["asset", "liability", "equity", "income", "expense"];

function mapRow(row: any): AccountCategory {
  return {
    id: row.id,
    businessUnit: row.business_unit,
    value: row.value,
    label: row.label,
    type: row.type,
    codeHint: row.code_hint,
    isActive: !!row.is_active,
  };
}

/**
 * "Kategori Akun" -- finer account grouping (Cash & Bank, Fixed Assets, etc.) shown in
 * the B2B "Daftar Akun" create form. Started as a hardcoded list; now managed here so
 * it can be edited/extended via Settings without a code change.
 */
export const accountCategoriesController = {
  async list(req: Request, res: Response) {
    const includeArchived = req.query.includeArchived === "true";
    const activeClause = includeArchived ? "" : "AND is_active = TRUE";
    const [rows] = await pool.query(
      `SELECT * FROM account_categories WHERE business_unit = ? ${activeClause} ORDER BY label`,
      [req.businessUnit]
    );
    res.json((rows as any[]).map(mapRow));
  },

  async create(req: Request, res: Response) {
    const { value, label, type, codeHint } = req.body;
    if (!value || !label || !type) throw new ApiError(400, "Value, label, dan tipe wajib diisi");
    if (!ACCOUNT_TYPES.includes(type)) throw new ApiError(400, `Tipe harus salah satu dari: ${ACCOUNT_TYPES.join(", ")}`);

    const [result] = await pool.query(
      "INSERT INTO account_categories (business_unit, value, label, type, code_hint) VALUES (?, ?, ?, ?, ?)",
      [req.businessUnit, value, label, type, codeHint || null]
    );
    const insertId = (result as any).insertId;
    const [rows] = await pool.query("SELECT * FROM account_categories WHERE id = ?", [insertId]);
    res.status(201).json(mapRow((rows as any[])[0]));
  },

  // `type` is intentionally not editable here -- existing accounts may already have
  // been created against this category's original type; changing it later would make
  // that history inconsistent. Archive and create a new category instead if needed.
  async update(req: Request, res: Response) {
    const { label, codeHint, isActive } = req.body;
    const [existing] = await pool.query("SELECT * FROM account_categories WHERE id = ?", [req.params.id]);
    const current = (existing as any[])[0];
    if (!current || current.business_unit !== req.businessUnit) throw new ApiError(404, "Kategori akun tidak ditemukan");

    await pool.query("UPDATE account_categories SET label = ?, code_hint = ?, is_active = ? WHERE id = ?", [
      label ?? current.label,
      codeHint === undefined ? current.code_hint : codeHint || null,
      isActive === undefined ? current.is_active : isActive,
      req.params.id,
    ]);
    const [rows] = await pool.query("SELECT * FROM account_categories WHERE id = ?", [req.params.id]);
    res.json(mapRow((rows as any[])[0]));
  },
};
