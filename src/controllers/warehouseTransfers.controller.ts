import { Request, Response } from "express";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { adjustWarehouseStock, getWarehouseStock } from "../utils/warehouseStock";

/**
 * "Transfer Gudang" -- moves qty of qty-tracked products between two warehouse
 * allocations (product_warehouse_stock; NULL = "Unassigned"). A transfer doesn't
 * create or destroy stock, so products.current_stock (the total across every
 * warehouse) is untouched -- only the per-warehouse split changes.
 */

async function nextTransferNumber(businessUnit: string): Promise<string> {
  const [rows] = await pool.query("SELECT COUNT(*) AS cnt FROM warehouse_transfers WHERE business_unit = ?", [businessUnit]);
  return `WT-${String(1 + (rows as any[])[0].cnt).padStart(4, "0")}`;
}

async function attachDetails(businessUnit: string, transfers: any[]) {
  if (!transfers.length) return transfers.map((t) => ({ ...t, lines: [], attachments: [] }));
  const ids = transfers.map((t) => t.id);

  const [lineRows] = await pool.query(
    `SELECT l.*, p.name AS product_name, p.unit AS product_unit
     FROM warehouse_transfer_lines l
     JOIN products p ON p.id = l.product_id
     WHERE l.warehouse_transfer_id IN (?)`,
    [ids]
  );
  const linesByTransfer = new Map<number, any[]>();
  for (const row of lineRows as any[]) {
    const list = linesByTransfer.get(row.warehouse_transfer_id) ?? [];
    list.push({
      id: row.id,
      productId: row.product_id,
      productName: row.product_name,
      productUnit: row.product_unit,
      qtyBefore: Number(row.qty_before),
      qtyAfter: Number(row.qty_after),
      qtyTransferred: Number(row.qty_transferred),
    });
    linesByTransfer.set(row.warehouse_transfer_id, list);
  }

  const [attachmentRows] = await pool.query(
    `SELECT * FROM warehouse_transfer_attachments WHERE warehouse_transfer_id IN (?)`,
    [ids]
  );
  const attachmentsByTransfer = new Map<number, any[]>();
  for (const row of attachmentRows as any[]) {
    const list = attachmentsByTransfer.get(row.warehouse_transfer_id) ?? [];
    list.push({ id: row.id, fileName: row.file_name, url: row.url });
    attachmentsByTransfer.set(row.warehouse_transfer_id, list);
  }

  return transfers.map((t) => ({ ...t, lines: linesByTransfer.get(t.id) ?? [], attachments: attachmentsByTransfer.get(t.id) ?? [] }));
}

function mapRow(row: any) {
  return {
    id: row.id,
    businessUnit: row.business_unit,
    transferNumber: row.transfer_number,
    fromWarehouseId: row.from_warehouse_id,
    fromWarehouseName: row.from_warehouse_name,
    toWarehouseId: row.to_warehouse_id,
    toWarehouseName: row.to_warehouse_name,
    transferDate: row.transfer_date,
    memo: row.memo,
    createdAt: row.created_at,
  };
}

const SELECT_WITH_WAREHOUSES = `
  SELECT wt.*, fw.name AS from_warehouse_name, tw.name AS to_warehouse_name
  FROM warehouse_transfers wt
  LEFT JOIN warehouses fw ON fw.id = wt.from_warehouse_id
  LEFT JOIN warehouses tw ON tw.id = wt.to_warehouse_id
`;

export const warehouseTransfersController = {
  async list(req: Request, res: Response) {
    const [rows] = await pool.query(`${SELECT_WITH_WAREHOUSES} WHERE wt.business_unit = ? ORDER BY wt.transfer_date DESC, wt.id DESC`, [
      req.businessUnit,
    ]);
    res.json(await attachDetails(req.businessUnit, (rows as any[]).map(mapRow)));
  },

  async create(req: Request, res: Response) {
    const { fromWarehouseId, toWarehouseId, transferDate, memo, lines, attachments } = req.body;

    if (!transferDate) throw new ApiError(400, "Tanggal wajib diisi");
    const resolvedFrom = fromWarehouseId ? Number(fromWarehouseId) : null;
    const resolvedTo = toWarehouseId ? Number(toWarehouseId) : null;
    if (resolvedFrom === resolvedTo) throw new ApiError(400, "Dari gudang dan ke gudang tidak boleh sama");

    const requestedLines: { productId?: unknown; qty?: unknown }[] = Array.isArray(lines) ? lines : [];
    const productIds = requestedLines.map((l) => Number(l.productId)).filter((id) => Number.isFinite(id) && id > 0);
    if (!productIds.length) throw new ApiError(400, "Minimal 1 produk wajib ditambahkan");

    const [productRows] = await pool.query(`SELECT id, name, track_inventory FROM products WHERE business_unit = ? AND id IN (?)`, [
      req.businessUnit,
      productIds,
    ]);
    const productsById = new Map((productRows as any[]).map((p) => [p.id, p]));

    const computedLines: { productId: number; qtyBefore: number; qtyAfter: number; qtyTransferred: number }[] = [];
    for (const l of requestedLines) {
      const productId = Number(l.productId);
      const product = productsById.get(productId);
      if (!product) continue;
      if (!product.track_inventory) throw new ApiError(400, `Produk "${product.name}" tidak melacak persediaan, tidak bisa ditransfer`);

      const qty = Number(l.qty) || 0;
      if (qty <= 0) throw new ApiError(400, `Qty transfer "${product.name}" harus lebih dari 0`);
      const qtyBefore = await getWarehouseStock(productId, resolvedFrom);
      if (qty > qtyBefore) throw new ApiError(400, `Stok "${product.name}" di gudang asal tidak cukup (tersedia ${qtyBefore})`);
      computedLines.push({ productId, qtyBefore, qtyAfter: qtyBefore - qty, qtyTransferred: qty });
    }
    if (!computedLines.length) throw new ApiError(400, "Minimal 1 produk wajib ditambahkan");

    const finalNumber = await nextTransferNumber(req.businessUnit);

    const [result] = await pool.query(
      `INSERT INTO warehouse_transfers (business_unit, transfer_number, from_warehouse_id, to_warehouse_id, transfer_date, memo)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.businessUnit, finalNumber, resolvedFrom, resolvedTo, transferDate, memo || null]
    );
    const insertId = (result as any).insertId;

    for (const line of computedLines) {
      await pool.query(
        "INSERT INTO warehouse_transfer_lines (warehouse_transfer_id, product_id, qty_before, qty_after, qty_transferred) VALUES (?, ?, ?, ?, ?)",
        [insertId, line.productId, line.qtyBefore, line.qtyAfter, line.qtyTransferred]
      );
      await adjustWarehouseStock(line.productId, resolvedFrom, -line.qtyTransferred);
      await adjustWarehouseStock(line.productId, resolvedTo, line.qtyTransferred);
    }

    const requestedAttachments: { fileName?: unknown; url?: unknown }[] = Array.isArray(attachments) ? attachments : [];
    for (const a of requestedAttachments) {
      if (!a.url || !a.fileName) continue;
      await pool.query("INSERT INTO warehouse_transfer_attachments (warehouse_transfer_id, file_name, url) VALUES (?, ?, ?)", [
        insertId,
        String(a.fileName),
        String(a.url),
      ]);
    }

    const [rows] = await pool.query(`${SELECT_WITH_WAREHOUSES} WHERE wt.id = ?`, [insertId]);
    const [withDetails] = await attachDetails(req.businessUnit, [mapRow((rows as any[])[0])]);
    res.status(201).json(withDetails);
  },

  /** Real upload -- saved to disk under uploads/attachments (see
   * routes/warehouseTransfers.routes.ts's multer disk storage) and served back at the
   * returned URL via app.ts's static route. Not tied to a transfer yet; the form
   * uploads files first, then sends their URLs along with the rest of the transfer. */
  async uploadAttachment(req: Request, res: Response) {
    const files = (req.files as Express.Multer.File[]) ?? [];
    if (!files.length) throw new ApiError(400, "File wajib diunggah");
    res.status(201).json(files.map((f) => ({ fileName: f.originalname, url: `/uploads/attachments/${f.filename}` })));
  },
};
