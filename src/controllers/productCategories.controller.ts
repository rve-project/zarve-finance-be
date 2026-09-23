import { Request, Response } from "express";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { ProductCategory } from "../models/types";

function mapRow(row: any): ProductCategory {
  return {
    id: row.id,
    businessUnit: row.business_unit,
    name: row.name,
    isActive: !!row.is_active,
  };
}

/** "Atur kategori produk" -- a plain managed list, same pattern as account_categories. */
export const productCategoriesController = {
  async list(req: Request, res: Response) {
    const includeArchived = req.query.includeArchived === "true";
    const activeClause = includeArchived ? "" : "AND is_active = TRUE";
    const [rows] = await pool.query(`SELECT * FROM product_categories WHERE business_unit = ? ${activeClause} ORDER BY name`, [
      req.businessUnit,
    ]);
    res.json((rows as any[]).map(mapRow));
  },

  async create(req: Request, res: Response) {
    const { name } = req.body;
    if (!name) throw new ApiError(400, "Nama kategori wajib diisi");
    const [result] = await pool.query("INSERT INTO product_categories (business_unit, name) VALUES (?, ?)", [req.businessUnit, name]);
    const insertId = (result as any).insertId;
    const [rows] = await pool.query("SELECT * FROM product_categories WHERE id = ?", [insertId]);
    res.status(201).json(mapRow((rows as any[])[0]));
  },
};
