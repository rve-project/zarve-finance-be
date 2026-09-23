import { Request, Response } from "express";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { OrderStatus, OrderType } from "../models/types";

/**
 * "Pemenuhan" (order fulfillment) board -- purely operational/logistics tracking
 * (Pesanan Baru -> Sedang Diproses -> Sedang Dikirim -> Selesai/Dibatalkan), matching
 * Mekari Jurnal's own board. Status moves manually, same as Mekari's (no live courier
 * integration). Deliberately NOT wired into the ledger -- no journal entry is posted
 * from here.
 */

const ORDER_TYPES: OrderType[] = ["sale", "purchase"];
const ORDER_STATUSES: OrderStatus[] = ["new", "processing", "shipping", "completed", "cancelled"];

function mapRow(row: any) {
  return {
    id: row.id,
    businessUnit: row.business_unit,
    type: row.type,
    orderNumber: row.order_number,
    partyName: row.party_name,
    orderDate: row.order_date,
    amount: Number(row.amount),
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function nextOrderNumber(businessUnit: string, type: OrderType): Promise<string> {
  const prefix = type === "sale" ? "SO" : "PO";
  const [rows] = await pool.query("SELECT COUNT(*) AS cnt FROM orders WHERE business_unit = ? AND type = ?", [businessUnit, type]);
  const n = (rows as any[])[0].cnt + 1;
  return `${prefix}-${String(n).padStart(4, "0")}`;
}

export const ordersController = {
  async list(req: Request, res: Response) {
    const { type, from, to, search } = req.query;
    if (!type || !ORDER_TYPES.includes(type as OrderType)) throw new ApiError(400, `type wajib salah satu dari: ${ORDER_TYPES.join(", ")}`);

    const clauses: string[] = ["business_unit = ?", "type = ?"];
    const params: unknown[] = [req.businessUnit, type];
    if (from) {
      clauses.push("order_date >= ?");
      params.push(from);
    }
    if (to) {
      clauses.push("order_date <= ?");
      params.push(to);
    }
    if (search) {
      clauses.push("(order_number LIKE ? OR party_name LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }
    const where = `WHERE ${clauses.join(" AND ")}`;

    const [rows] = await pool.query(`SELECT * FROM orders ${where} ORDER BY order_date DESC, id DESC`, params);
    const orders = (rows as any[]).map(mapRow);

    const byStatus: Record<OrderStatus, typeof orders> = { new: [], processing: [], shipping: [], completed: [], cancelled: [] };
    for (const o of orders) byStatus[o.status as OrderStatus].push(o);

    res.json(byStatus);
  },

  async create(req: Request, res: Response) {
    const { type, orderNumber, partyName, orderDate, amount, notes } = req.body;
    if (!type || !ORDER_TYPES.includes(type)) throw new ApiError(400, `type wajib salah satu dari: ${ORDER_TYPES.join(", ")}`);
    if (!partyName || !orderDate) throw new ApiError(400, "Nama pihak dan tanggal pesanan wajib diisi");

    const finalOrderNumber = orderNumber || (await nextOrderNumber(req.businessUnit, type));

    const [result] = await pool.query(
      "INSERT INTO orders (business_unit, type, order_number, party_name, order_date, amount, notes) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [req.businessUnit, type, finalOrderNumber, partyName, orderDate, Number(amount) || 0, notes || null]
    );
    const insertId = (result as any).insertId;
    const [rows] = await pool.query("SELECT * FROM orders WHERE id = ?", [insertId]);
    res.status(201).json(mapRow((rows as any[])[0]));
  },

  async updateStatus(req: Request, res: Response) {
    const { status } = req.body;
    if (!status || !ORDER_STATUSES.includes(status)) throw new ApiError(400, `status wajib salah satu dari: ${ORDER_STATUSES.join(", ")}`);

    const [existing] = await pool.query("SELECT * FROM orders WHERE id = ?", [req.params.id]);
    const current = (existing as any[])[0];
    if (!current || current.business_unit !== req.businessUnit) throw new ApiError(404, "Pesanan tidak ditemukan");

    await pool.query("UPDATE orders SET status = ? WHERE id = ?", [status, req.params.id]);
    const [rows] = await pool.query("SELECT * FROM orders WHERE id = ?", [req.params.id]);
    res.json(mapRow((rows as any[])[0]));
  },
};
