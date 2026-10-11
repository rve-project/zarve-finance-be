import { Request, Response } from "express";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { PaymentTerm } from "../models/types";

function mapRow(row: any): PaymentTerm {
  return {
    id: row.id,
    businessUnit: row.business_unit,
    name: row.name,
    days: row.days === null ? null : Number(row.days),
    isActive: !!row.is_active,
  };
}

/**
 * "Syarat Pembayaran" (e.g. "Net 30") for the Penjualan/Pembelian/Kontak forms' payment
 * term picker -- mirrors banks.controller.ts/taxes.controller.ts exactly, editable via
 * Settings instead of a hardcoded list duplicated across several form files. `days`
 * drives each form's own "auto-fill due date from document date" behavior; NULL means
 * "Custom" (due date left to the user to pick manually) -- see migration
 * 054_payment_terms.sql.
 */
export const paymentTermsController = {
  async list(req: Request, res: Response) {
    const includeArchived = req.query.includeArchived === "true";
    const activeClause = includeArchived ? "" : "AND is_active = TRUE";
    const [rows] = await pool.query(`SELECT * FROM payment_terms WHERE business_unit = ? ${activeClause} ORDER BY days IS NULL, days, name`, [
      req.businessUnit,
    ]);
    res.json((rows as any[]).map(mapRow));
  },

  async create(req: Request, res: Response) {
    const { name, days } = req.body;
    if (!name) throw new ApiError(400, "Nama syarat pembayaran wajib diisi");
    if (days !== undefined && days !== null && days !== "" && (Number.isNaN(Number(days)) || Number(days) < 0)) {
      throw new ApiError(400, "Jumlah hari harus berupa angka >= 0");
    }

    const [result] = await pool.query("INSERT INTO payment_terms (business_unit, name, days) VALUES (?, ?, ?)", [
      req.businessUnit,
      name,
      days === undefined || days === null || days === "" ? null : Number(days),
    ]);
    const insertId = (result as any).insertId;
    const [rows] = await pool.query("SELECT * FROM payment_terms WHERE id = ?", [insertId]);
    res.status(201).json(mapRow((rows as any[])[0]));
  },

  async update(req: Request, res: Response) {
    const { name, days, isActive } = req.body;
    const [existing] = await pool.query("SELECT * FROM payment_terms WHERE id = ?", [req.params.id]);
    const current = (existing as any[])[0];
    if (!current || current.business_unit !== req.businessUnit) throw new ApiError(404, "Syarat pembayaran tidak ditemukan");

    await pool.query("UPDATE payment_terms SET name = ?, days = ?, is_active = ? WHERE id = ?", [
      name ?? current.name,
      days === undefined ? current.days : days === null || days === "" ? null : Number(days),
      isActive === undefined ? current.is_active : isActive,
      req.params.id,
    ]);
    const [rows] = await pool.query("SELECT * FROM payment_terms WHERE id = ?", [req.params.id]);
    res.json(mapRow((rows as any[])[0]));
  },
};
