import { PoolConnection } from "mysql2/promise";
import { pool } from "../db";

/**
 * Per-warehouse stock allocation, upserted with a NULL-safe warehouse_id comparison
 * (`<=>`) since there's no DB-level unique constraint on (product_id, warehouse_id) --
 * MySQL treats every NULL as distinct in a unique index, which would let duplicate
 * "Unassigned" (warehouse_id NULL) rows slip in. `delta` is added to whatever is
 * already there (0 if no row exists yet).
 */
export async function adjustWarehouseStock(
  productId: number,
  warehouseId: number | null,
  delta: number,
  conn?: PoolConnection
): Promise<number> {
  const runner = conn ?? pool;
  const [rows] = await runner.query(
    "SELECT id, qty FROM product_warehouse_stock WHERE product_id = ? AND warehouse_id <=> ? FOR UPDATE",
    [productId, warehouseId]
  );
  const existing = (rows as any[])[0];
  const newQty = (existing ? Number(existing.qty) : 0) + delta;
  if (existing) {
    await runner.query("UPDATE product_warehouse_stock SET qty = ? WHERE id = ?", [newQty, existing.id]);
  } else {
    await runner.query("INSERT INTO product_warehouse_stock (product_id, warehouse_id, qty) VALUES (?, ?, ?)", [productId, warehouseId, newQty]);
  }
  return newQty;
}

export async function getWarehouseStock(productId: number, warehouseId: number | null, conn?: PoolConnection): Promise<number> {
  const runner = conn ?? pool;
  const [rows] = await runner.query("SELECT qty FROM product_warehouse_stock WHERE product_id = ? AND warehouse_id <=> ?", [productId, warehouseId]);
  const existing = (rows as any[])[0];
  return existing ? Number(existing.qty) : 0;
}
