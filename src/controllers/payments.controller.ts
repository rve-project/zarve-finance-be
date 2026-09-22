import { Request, Response } from "express";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { Payment } from "../models/types";
import { postJournalEntry, WELL_KNOWN_ACCOUNTS, getAccountIdByCode } from "../utils/ledger";

function mapRow(row: any): Payment {
  return {
    id: row.id,
    partnerId: row.partner_id,
    invoiceId: row.invoice_id,
    amount: Number(row.amount),
    date: row.date,
    method: row.method,
    memo: row.memo,
    reconciliationId: row.reconciliation_id,
    createdAt: row.created_at,
  };
}

export interface CreatePaymentInput {
  partnerId: number;
  invoiceId: number | null;
  amount: number;
  date: string;
  method?: string | null;
  memo?: string | null;
}

/**
 * Record + post a customer payment (Debit Undeposited Funds, Credit Piutang Usaha).
 * This is a direct reconciliation against `invoiceId` -- no partial-allocation table yet
 * (see plan: `payment_allocations` was considered but dropped for MVP since the import
 * pipeline always pays exactly one invoice per payment, one per day).
 */
export async function createPayment(input: CreatePaymentInput): Promise<Payment> {
  if (input.amount <= 0) throw new ApiError(400, "Jumlah pembayaran harus lebih dari 0");

  const arAccountId = await getAccountIdByCode(WELL_KNOWN_ACCOUNTS.ACCOUNTS_RECEIVABLE);
  const undepositedAccountId = await getAccountIdByCode(WELL_KNOWN_ACCOUNTS.UNDEPOSITED_FUNDS);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [result] = await conn.query(
      "INSERT INTO payments (partner_id, invoice_id, amount, date, method, memo) VALUES (?, ?, ?, ?, ?, ?)",
      [input.partnerId, input.invoiceId, input.amount, input.date, input.method ?? null, input.memo ?? null]
    );
    const paymentId = (result as any).insertId;

    await postJournalEntry(
      {
        date: input.date,
        ref: `PAY-${paymentId}`,
        narration: input.memo ?? `Payment #${paymentId}`,
        sourceType: "payment",
        sourceId: paymentId,
        lines: [
          { accountId: undepositedAccountId, partnerId: input.partnerId, debit: input.amount, credit: 0 },
          { accountId: arAccountId, partnerId: input.partnerId, debit: 0, credit: input.amount },
        ],
      },
      conn
    );

    await conn.commit();
    const [rows] = await pool.query("SELECT * FROM payments WHERE id = ?", [paymentId]);
    return mapRow((rows as any[])[0]);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export const paymentsController = {
  async list(req: Request, res: Response) {
    const { partnerId, invoiceId } = req.query;
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (partnerId) {
      clauses.push("partner_id = ?");
      params.push(partnerId);
    }
    if (invoiceId) {
      clauses.push("invoice_id = ?");
      params.push(invoiceId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const [rows] = await pool.query(`SELECT * FROM payments ${where} ORDER BY date DESC, id DESC LIMIT 500`, params);
    res.json((rows as any[]).map(mapRow));
  },

  async get(req: Request, res: Response) {
    const [rows] = await pool.query("SELECT * FROM payments WHERE id = ?", [req.params.id]);
    const row = (rows as any[])[0];
    if (!row) throw new ApiError(404, "Payment tidak ditemukan");
    res.json(mapRow(row));
  },

  async create(req: Request, res: Response) {
    const { partnerId, invoiceId, amount, date, method, memo } = req.body;
    if (!partnerId || !amount || !date) throw new ApiError(400, "partnerId, amount, dan date wajib diisi");
    const payment = await createPayment({
      partnerId,
      invoiceId: invoiceId ?? null,
      amount: Number(amount),
      date,
      method,
      memo,
    });
    res.status(201).json(payment);
  },
};
