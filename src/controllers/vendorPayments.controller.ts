import { Request, Response } from "express";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { postJournalEntry, WELL_KNOWN_ACCOUNTS, getAccountIdByCode } from "../utils/ledger";

/**
 * Paying a vendor bill -- debits Accounts Payable, credits whichever bank/cash account
 * actually paid it. Unlike customer payments (which land in Undeposited Funds first,
 * see payments.controller.ts, because the exact bank isn't known until reconciliation),
 * an outgoing payment's source account is always known at the moment it's made.
 */
function mapRow(row: any) {
  return {
    id: row.id,
    vendorId: row.vendor_id,
    vendorName: row.vendor_name,
    vendorBillId: row.vendor_bill_id,
    bankAccountId: row.bank_account_id,
    amount: Number(row.amount),
    date: row.date,
    method: row.method,
    memo: row.memo,
    createdAt: row.created_at,
  };
}

export const vendorPaymentsController = {
  async list(req: Request, res: Response) {
    const { vendorId, vendorBillId } = req.query;
    const page = req.query.page ? Number(req.query.page) : 1;
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (vendorId) {
      clauses.push("vp.vendor_id = ?");
      params.push(vendorId);
    }
    if (vendorBillId) {
      clauses.push("vp.vendor_bill_id = ?");
      params.push(vendorBillId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const [countRows] = await pool.query(`SELECT COUNT(*) AS cnt FROM vendor_payments vp ${where}`, params);
    const total = (countRows as any[])[0].cnt as number;

    const [rows] = await pool.query(
      `SELECT vp.*, p.name AS vendor_name FROM vendor_payments vp JOIN partners p ON p.id = vp.vendor_id ${where}
       ORDER BY vp.date DESC, vp.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]
    );
    res.json({ total, page, limit, data: (rows as any[]).map(mapRow) });
  },

  async create(req: Request, res: Response) {
    const { vendorId, vendorBillId, bankAccountId, amount, date, method, memo } = req.body;
    if (!vendorId || !bankAccountId || !amount || !date) {
      throw new ApiError(400, "vendorId, bankAccountId, amount, dan date wajib diisi");
    }
    if (Number(amount) <= 0) throw new ApiError(400, "Jumlah pembayaran harus lebih dari 0");

    const apAccountId = await getAccountIdByCode(WELL_KNOWN_ACCOUNTS.ACCOUNTS_PAYABLE);

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [result] = await conn.query(
        "INSERT INTO vendor_payments (vendor_id, vendor_bill_id, bank_account_id, amount, date, method, memo) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [vendorId, vendorBillId ?? null, bankAccountId, amount, date, method ?? null, memo ?? null]
      );
      const paymentId = (result as any).insertId;

      await postJournalEntry(
        {
          date,
          ref: `VPAY-${paymentId}`,
          narration: memo ?? `Pembayaran vendor #${paymentId}`,
          sourceType: "vendor_payment",
          sourceId: paymentId,
          lines: [
            { accountId: apAccountId, partnerId: Number(vendorId), debit: Number(amount), credit: 0 },
            { accountId: bankAccountId, debit: 0, credit: Number(amount) },
          ],
        },
        conn
      );

      await conn.commit();
      const [rows] = await pool.query(
        "SELECT vp.*, p.name AS vendor_name FROM vendor_payments vp JOIN partners p ON p.id = vp.vendor_id WHERE vp.id = ?",
        [paymentId]
      );
      res.status(201).json(mapRow((rows as any[])[0]));
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },
};
