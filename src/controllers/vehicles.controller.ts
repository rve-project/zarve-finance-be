import { Request, Response } from "express";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { Vehicle, VehicleCategory } from "../models/types";

const CATEGORIES: VehicleCategory[] = ["ev", "fuel"];

function mapRow(row: any): Vehicle {
  return {
    id: row.id,
    platNumber: row.plate_number,
    name: row.name,
    category: row.category,
    branch: row.branch,
    incomeAccountId: row.income_account_id,
    analyticTag: row.analytic_tag,
  };
}

/** Normalize a plate for matching: uppercase, collapse whitespace. */
export function normalizePlate(plate: string): string {
  return plate.trim().toUpperCase().replace(/\s+/g, " ");
}

export async function findVehicleByPlate(plate: string): Promise<Vehicle | undefined> {
  const [rows] = await pool.query("SELECT * FROM vehicles WHERE plate_number = ?", [normalizePlate(plate)]);
  const row = (rows as any[])[0];
  return row ? mapRow(row) : undefined;
}

export const vehiclesController = {
  async list(req: Request, res: Response) {
    const [rows] = await pool.query("SELECT * FROM vehicles ORDER BY plate_number");
    res.json((rows as any[]).map(mapRow));
  },

  async get(req: Request, res: Response) {
    const [rows] = await pool.query("SELECT * FROM vehicles WHERE id = ?", [req.params.id]);
    const row = (rows as any[])[0];
    if (!row) throw new ApiError(404, "Kendaraan tidak ditemukan");
    res.json(mapRow(row));
  },

  async create(req: Request, res: Response) {
    const { platNumber, name, category, branch, incomeAccountId, analyticTag } = req.body;
    if (!platNumber || !name) throw new ApiError(400, "Plat nomor dan nama kendaraan wajib diisi");
    const cat = category && CATEGORIES.includes(category) ? category : "fuel";

    const [result] = await pool.query(
      "INSERT INTO vehicles (plate_number, name, category, branch, income_account_id, analytic_tag) VALUES (?, ?, ?, ?, ?, ?)",
      [normalizePlate(platNumber), name, cat, branch ?? null, incomeAccountId ?? null, analyticTag ?? null]
    );
    const insertId = (result as any).insertId;
    const [rows] = await pool.query("SELECT * FROM vehicles WHERE id = ?", [insertId]);
    res.status(201).json(mapRow((rows as any[])[0]));
  },

  async update(req: Request, res: Response) {
    const { name, category, branch, incomeAccountId, analyticTag } = req.body;
    const [existing] = await pool.query("SELECT * FROM vehicles WHERE id = ?", [req.params.id]);
    const current = (existing as any[])[0];
    if (!current) throw new ApiError(404, "Kendaraan tidak ditemukan");

    await pool.query(
      "UPDATE vehicles SET name = ?, category = ?, branch = ?, income_account_id = ?, analytic_tag = ? WHERE id = ?",
      [
        name ?? current.name,
        category && CATEGORIES.includes(category) ? category : current.category,
        branch === undefined ? current.branch : branch,
        incomeAccountId === undefined ? current.income_account_id : incomeAccountId,
        analyticTag === undefined ? current.analytic_tag : analyticTag,
        req.params.id,
      ]
    );
    const [rows] = await pool.query("SELECT * FROM vehicles WHERE id = ?", [req.params.id]);
    res.json(mapRow((rows as any[])[0]));
  },
};
