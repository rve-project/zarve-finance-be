import { Request, Response } from "express";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { getInvoiceDetail, getInvoiceTypes } from "../utils/zarveApiClient";
import { mapMirrorInvoiceRow } from "../utils/zarveMirror";

/**
 * Backs the "Invoice" menu -- list/type-filter reads from the local Zarve mirror (see
 * zarveMirrorSync.ts) so browsing/filtering is instant regardless of how large the
 * full invoice history is. `detail` is the one exception left as a live single-record
 * call to Zarve: it's only ever fetched one at a time on click, so the latency doesn't
 * matter, and it saves mirroring full line-item detail for every invoice up front.
 */
export const zarveInvoicesController = {
  async list(req: Request, res: Response) {
    const page = req.query.page ? Number(req.query.page) : 1;
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const { status, type, search, startDate, endDate } = req.query;

    const clauses: string[] = [];
    const params: unknown[] = [];
    if (status) {
      clauses.push("status = ?");
      params.push(status);
    }
    if (type) {
      clauses.push("type = ?");
      params.push(type);
    }
    if (startDate) {
      clauses.push("invoice_date >= ?");
      params.push(startDate);
    }
    if (endDate) {
      clauses.push("invoice_date <= ?");
      params.push(endDate);
    }
    if (search) {
      clauses.push("(driver_name LIKE ? OR vehicle_plate LIKE ? OR invoice_number LIKE ? OR order_number LIKE ?)");
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const [countRows] = await pool.query(`SELECT COUNT(*) AS cnt FROM zarve_invoices ${where}`, params);
    const total = (countRows as any[])[0].cnt as number;

    const [rows] = await pool.query(
      `SELECT * FROM zarve_invoices ${where} ORDER BY invoice_date DESC, created_at_zarve DESC LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]
    );

    res.json({ total, page, limit, data: (rows as any[]).map(mapMirrorInvoiceRow) });
  },

  // Small, static reference list (~10 rows) -- kept as a live, TTL-cached call rather
  // than mirrored, unlike the invoice records themselves.
  async types(_req: Request, res: Response) {
    const types = await getInvoiceTypes();
    res.json(types.filter((t) => t.isActive));
  },

  async detail(req: Request, res: Response) {
    const id = req.params.id as string;
    if (!id) throw new ApiError(400, "id wajib diisi");
    const invoice = await getInvoiceDetail(id);
    res.json(invoice);
  },
};
