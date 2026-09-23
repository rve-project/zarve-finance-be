import { Request, Response } from "express";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";

/**
 * "Gudang" -- Daftar gudang only for now. Stock stays one flat number on each product
 * (see products.controller.ts), not split per warehouse, so there's no transfer or
 * approval data to show yet -- those sub-tabs stay empty-state on the frontend.
 * Penanggung Jawab is a list (up to 5, enforced frontend-side) via warehouse_pics --
 * matching Mekari's form, though the PIC email-reminder behavior it describes (low
 * stock / expiring batch alerts) isn't implemented.
 */

const MAX_PICS = 5;

function mapRow(row: any) {
  return {
    id: row.id,
    businessUnit: row.business_unit,
    code: row.code,
    name: row.name,
    address: row.address,
    notes: row.notes,
    isActive: !!row.is_active,
    createdAt: row.created_at,
  };
}

async function nextWarehouseCode(businessUnit: string): Promise<string> {
  const [rows] = await pool.query("SELECT COUNT(*) AS cnt FROM warehouses WHERE business_unit = ?", [businessUnit]);
  return `WH-${String(1 + (rows as any[])[0].cnt).padStart(3, "0")}`;
}

async function picsByWarehouseIds(warehouseIds: number[]): Promise<Map<number, { id: number; name: string }[]>> {
  const map = new Map<number, { id: number; name: string }[]>();
  if (!warehouseIds.length) return map;
  const [rows] = await pool.query(
    `SELECT wp.warehouse_id, u.id, u.name FROM warehouse_pics wp JOIN users u ON u.id = wp.user_id WHERE wp.warehouse_id IN (?) ORDER BY u.name`,
    [warehouseIds]
  );
  for (const row of rows as any[]) {
    const list = map.get(row.warehouse_id) ?? [];
    list.push({ id: row.id, name: row.name });
    map.set(row.warehouse_id, list);
  }
  return map;
}

export const warehousesController = {
  async list(req: Request, res: Response) {
    const includeArchived = req.query.includeArchived === "true";
    const search = (req.query.search as string) || "";

    const clauses: string[] = ["w.business_unit = ?"];
    const params: unknown[] = [req.businessUnit];
    if (!includeArchived) clauses.push("w.is_active = TRUE");
    if (search) {
      clauses.push("(w.name LIKE ? OR w.code LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }
    const where = `WHERE ${clauses.join(" AND ")}`;

    const [rows] = await pool.query(`SELECT w.* FROM warehouses w ${where} ORDER BY w.name`, params);
    const warehouses = rows as any[];
    const picsMap = await picsByWarehouseIds(warehouses.map((w) => w.id));
    res.json(warehouses.map((w) => ({ ...mapRow(w), pics: picsMap.get(w.id) ?? [] })));
  },

  async create(req: Request, res: Response) {
    const { code, name, picUserIds, address, notes } = req.body;
    if (!name) throw new ApiError(400, "Nama gudang wajib diisi");

    const requestedPicIds: number[] = Array.isArray(picUserIds) ? [...new Set(picUserIds.map(Number).filter((id) => Number.isFinite(id) && id > 0))] : [];
    if (requestedPicIds.length > MAX_PICS) throw new ApiError(400, `Penanggung jawab maksimal ${MAX_PICS} orang`);

    const finalCode = code || (await nextWarehouseCode(req.businessUnit));

    const [result] = await pool.query("INSERT INTO warehouses (business_unit, code, name, address, notes) VALUES (?, ?, ?, ?, ?)", [
      req.businessUnit,
      finalCode,
      name,
      address || null,
      notes || null,
    ]);
    const insertId = (result as any).insertId;

    if (requestedPicIds.length) {
      await pool.query(
        `INSERT INTO warehouse_pics (warehouse_id, user_id) VALUES ${requestedPicIds.map(() => "(?, ?)").join(", ")}`,
        requestedPicIds.flatMap((userId) => [insertId, userId])
      );
    }

    const [rows] = await pool.query("SELECT * FROM warehouses WHERE id = ?", [insertId]);
    const picsMap = await picsByWarehouseIds([insertId]);
    res.status(201).json({ ...mapRow((rows as any[])[0]), pics: picsMap.get(insertId) ?? [] });
  },
};
