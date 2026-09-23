import { Request, Response } from "express";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { postJournalEntry } from "../utils/ledger";
import { adjustWarehouseStock, getWarehouseStock } from "../utils/warehouseStock";
import { StockAdjustmentCategory, StockAdjustmentType } from "../models/types";

/**
 * "Penyesuaian Stok" -- pick a type/category/account/date/warehouse, then list which
 * products change and by how much. Real effect: each line's "Qty sebelum"/"sesudah"
 * is that product's allocation in the chosen Gudang specifically (product_warehouse_
 * stock, NULL = "Unassigned"), and products.current_stock -- the TOTAL across every
 * warehouse -- moves by the same delta. If the product has a default inventory account
 * set, the value change (qty delta * purchase price) is posted as a real journal entry
 * against the chosen adjustment account; products without one just get their stock
 * updated, no posting. "Kategori penyesuaian" is a fixed, hardcoded list -- not
 * Settings-managed.
 */

const TYPES: StockAdjustmentType[] = ["count", "in_out"];
const CATEGORIES: StockAdjustmentCategory[] = ["general", "damaged", "production", "opening_quantity"];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function nextAdjustmentNumber(businessUnit: string): Promise<string> {
  const [rows] = await pool.query("SELECT COUNT(*) AS cnt FROM stock_adjustments WHERE business_unit = ?", [businessUnit]);
  return `PSD-${String(1 + (rows as any[])[0].cnt).padStart(4, "0")}`;
}

async function attachLines(businessUnit: string, adjustments: any[]) {
  if (!adjustments.length) return adjustments.map((a) => ({ ...a, lines: [] }));
  const ids = adjustments.map((a) => a.id);
  const [lineRows] = await pool.query(
    `SELECT l.*, p.name AS product_name, p.unit AS product_unit
     FROM stock_adjustment_lines l
     JOIN products p ON p.id = l.product_id
     WHERE l.stock_adjustment_id IN (?)`,
    [ids]
  );
  const linesByAdjustment = new Map<number, any[]>();
  for (const row of lineRows as any[]) {
    const list = linesByAdjustment.get(row.stock_adjustment_id) ?? [];
    list.push({
      id: row.id,
      productId: row.product_id,
      productName: row.product_name,
      productUnit: row.product_unit,
      stockBefore: Number(row.stock_before),
      stockAfter: Number(row.stock_after),
    });
    linesByAdjustment.set(row.stock_adjustment_id, list);
  }
  return adjustments.map((a) => ({ ...a, lines: linesByAdjustment.get(a.id) ?? [] }));
}

function mapRow(row: any) {
  return {
    id: row.id,
    businessUnit: row.business_unit,
    adjustmentNumber: row.adjustment_number,
    type: row.type,
    category: row.category,
    accountId: row.account_id,
    warehouseId: row.warehouse_id,
    warehouseName: row.warehouse_name,
    adjustmentDate: row.adjustment_date,
    memo: row.memo,
    journalEntryId: row.journal_entry_id,
    createdAt: row.created_at,
  };
}

export const stockAdjustmentsController = {
  async list(req: Request, res: Response) {
    const [rows] = await pool.query(
      `SELECT sa.*, w.name AS warehouse_name
       FROM stock_adjustments sa
       LEFT JOIN warehouses w ON w.id = sa.warehouse_id
       WHERE sa.business_unit = ?
       ORDER BY sa.adjustment_date DESC, sa.id DESC`,
      [req.businessUnit]
    );
    const mapped = (rows as any[]).map(mapRow);
    res.json(await attachLines(req.businessUnit, mapped));
  },

  async create(req: Request, res: Response) {
    const { type, category, accountId, warehouseId, adjustmentDate, memo, lines } = req.body;

    const resolvedType: StockAdjustmentType = TYPES.includes(type) ? type : "count";
    const resolvedCategory: StockAdjustmentCategory = CATEGORIES.includes(category) ? category : "general";
    if (!adjustmentDate) throw new ApiError(400, "Tanggal wajib diisi");

    const requestedLines: { productId?: unknown; value?: unknown }[] = Array.isArray(lines) ? lines : [];
    const productIds = requestedLines.map((l) => Number(l.productId)).filter((id) => Number.isFinite(id) && id > 0);
    if (!productIds.length) throw new ApiError(400, "Minimal 1 produk wajib ditambahkan");

    const [productRows] = await pool.query(
      `SELECT id, name, purchase_price, selling_price, inventory_account_id, track_inventory
       FROM products WHERE business_unit = ? AND id IN (?)`,
      [req.businessUnit, productIds]
    );
    const productsById = new Map((productRows as any[]).map((p) => [p.id, p]));
    const resolvedWarehouseId = warehouseId ? Number(warehouseId) : null;

    const computedLines: { productId: number; stockBefore: number; stockAfter: number }[] = [];
    for (const l of requestedLines) {
      const productId = Number(l.productId);
      const product = productsById.get(productId);
      if (!product) continue;
      if (!product.track_inventory) throw new ApiError(400, `Produk "${product.name}" tidak melacak persediaan, tidak bisa disesuaikan`);

      const stockBefore = await getWarehouseStock(productId, resolvedWarehouseId);
      const value = Number(l.value) || 0;
      const stockAfter = resolvedType === "count" ? value : stockBefore + value;
      if (stockAfter < 0) throw new ApiError(400, `Stok "${product.name}" tidak boleh negatif`);
      computedLines.push({ productId, stockBefore, stockAfter });
    }
    if (!computedLines.length) throw new ApiError(400, "Minimal 1 produk wajib ditambahkan");

    const finalNumber = await nextAdjustmentNumber(req.businessUnit);

    // Journal posting -- one line per distinct product inventory account for that
    // product's value delta, balanced by one aggregated line on the chosen adjustment
    // account. Only products with an inventory account set contribute; if none do (or
    // no adjustment account was chosen), stock still updates but nothing is posted.
    const journalLines: { accountId: number; debit: number; credit: number }[] = [];
    let netDelta = 0;
    for (const line of computedLines) {
      const product = productsById.get(line.productId)!;
      if (!product.inventory_account_id) continue;
      const unitCost = Number(product.purchase_price) || Number(product.selling_price) || 0;
      const delta = round2((line.stockAfter - line.stockBefore) * unitCost);
      if (!delta) continue;
      journalLines.push({ accountId: product.inventory_account_id, debit: delta > 0 ? delta : 0, credit: delta < 0 ? -delta : 0 });
      netDelta = round2(netDelta + delta);
    }
    let journalEntryId: number | null = null;
    if (accountId && journalLines.length && netDelta) {
      journalLines.push({ accountId: Number(accountId), debit: netDelta < 0 ? -netDelta : 0, credit: netDelta > 0 ? netDelta : 0 });
      journalEntryId = await postJournalEntry({
        date: adjustmentDate,
        ref: finalNumber,
        narration: `Penyesuaian stok: ${finalNumber}`,
        sourceType: "manual",
        businessUnit: req.businessUnit,
        lines: journalLines,
      });
    }

    const [result] = await pool.query(
      `INSERT INTO stock_adjustments (business_unit, adjustment_number, type, category, account_id, warehouse_id, adjustment_date, memo, journal_entry_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.businessUnit, finalNumber, resolvedType, resolvedCategory, accountId || null, resolvedWarehouseId, adjustmentDate, memo || null, journalEntryId]
    );
    const insertId = (result as any).insertId;

    for (const line of computedLines) {
      await pool.query("INSERT INTO stock_adjustment_lines (stock_adjustment_id, product_id, stock_before, stock_after) VALUES (?, ?, ?, ?)", [
        insertId,
        line.productId,
        line.stockBefore,
        line.stockAfter,
      ]);
      const delta = round2(line.stockAfter - line.stockBefore);
      await adjustWarehouseStock(line.productId, resolvedWarehouseId, delta);
      await pool.query("UPDATE products SET current_stock = current_stock + ? WHERE id = ?", [delta, line.productId]);
    }

    const [rows] = await pool.query(
      `SELECT sa.*, w.name AS warehouse_name FROM stock_adjustments sa LEFT JOIN warehouses w ON w.id = sa.warehouse_id WHERE sa.id = ?`,
      [insertId]
    );
    const [withLines] = await attachLines(req.businessUnit, [mapRow((rows as any[])[0])]);
    res.status(201).json(withLines);
  },
};
