import { Request, Response } from "express";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { postJournalEntry, WELL_KNOWN_ACCOUNTS, getAccountIdByCode } from "../utils/ledger";

/**
 * Bank reconciliation: every payment posts straight to Undeposited Funds (see
 * payments.controller.ts) with no way to move it into a real bank/cash account --
 * this is that missing step, matching Odoo Accounting's bank reconciliation. Select
 * one payment, several, or literally all of them (`all: true`) and sweep the total
 * into a chosen bank account in one journal entry, instead of Odoo's one-at-a-time-only
 * flow.
 */
function mapPaymentRow(row: any) {
  return {
    id: row.id,
    partnerId: row.partner_id,
    partnerName: row.partner_name,
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number,
    amount: Number(row.amount),
    date: row.date,
    method: row.method,
    memo: row.memo,
  };
}

export const reconciliationController = {
  async unreconciled(req: Request, res: Response) {
    const page = req.query.page ? Number(req.query.page) : 1;
    const limit = req.query.limit ? Number(req.query.limit) : 20;

    const [countRows] = await pool.query(
      "SELECT COUNT(*) AS cnt, COALESCE(SUM(amount), 0) AS total FROM payments WHERE reconciliation_id IS NULL"
    );
    const total = (countRows as any[])[0].cnt as number;
    const totalAmount = Number((countRows as any[])[0].total);

    const [rows] = await pool.query(
      `SELECT pay.*, p.name AS partner_name, inv.number AS invoice_number
       FROM payments pay
       LEFT JOIN partners p ON p.id = pay.partner_id
       LEFT JOIN invoices inv ON inv.id = pay.invoice_id
       WHERE pay.reconciliation_id IS NULL
       ORDER BY pay.date, pay.id
       LIMIT ? OFFSET ?`,
      [limit, (page - 1) * limit]
    );

    res.json({ total, totalAmount, page, limit, data: (rows as any[]).map(mapPaymentRow) });
  },

  async bankAccounts(_req: Request, res: Response) {
    // Bank/cash-type asset accounts (code prefix 11xx by this app's chart-of-accounts
    // convention), excluding Undeposited Funds itself -- that's the source, not a
    // valid reconciliation destination.
    const undepositedId = await getAccountIdByCode(WELL_KNOWN_ACCOUNTS.UNDEPOSITED_FUNDS);
    const [rows] = await pool.query(
      "SELECT * FROM accounts WHERE type = 'asset' AND code LIKE '11%' AND id != ? AND is_active = TRUE ORDER BY code",
      [undepositedId]
    );
    res.json(
      (rows as any[]).map((r) => ({ id: r.id, code: r.code, name: r.name, type: r.type, parentId: r.parent_id, isActive: !!r.is_active }))
    );
  },

  async create(req: Request, res: Response) {
    const { paymentIds, all, bankAccountId, date } = req.body;
    if (!bankAccountId || !date) throw new ApiError(400, "bankAccountId dan date wajib diisi");
    if (!all && (!Array.isArray(paymentIds) || !paymentIds.length)) {
      throw new ApiError(400, "paymentIds wajib diisi (atau kirim all: true untuk rekonsiliasi semua)");
    }

    const undepositedAccountId = await getAccountIdByCode(WELL_KNOWN_ACCOUNTS.UNDEPOSITED_FUNDS);

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // Locked so a concurrent reconciliation can't select the same rows -- selecting
      // "all" is resolved to concrete IDs here (not trusted from the client), so a
      // slow page full of unreconciled payments can't be reconciled twice by accident.
      const [rows] = await conn.query(
        `SELECT id, amount FROM payments WHERE reconciliation_id IS NULL ${all ? "" : "AND id IN (?)"} FOR UPDATE`,
        all ? [] : [paymentIds]
      );
      const selected = rows as { id: number; amount: string | number }[];
      if (!selected.length) throw new ApiError(400, "Tidak ada payment yang bisa direkonsiliasi (mungkin sudah direkonsiliasi lebih dulu).");

      const totalAmount = selected.reduce((sum, r) => sum + Number(r.amount), 0);

      const journalEntryId = await postJournalEntry(
        {
          date,
          ref: `RECON-${date}`,
          narration: `Rekonsiliasi bank -- ${selected.length} payment`,
          sourceType: "manual",
          lines: [
            { accountId: bankAccountId, debit: totalAmount, credit: 0 },
            { accountId: undepositedAccountId, debit: 0, credit: totalAmount },
          ],
        },
        conn
      );

      const [reconResult] = await conn.query(
        "INSERT INTO bank_reconciliations (bank_account_id, date, total_amount, payment_count, journal_entry_id) VALUES (?, ?, ?, ?, ?)",
        [bankAccountId, date, totalAmount, selected.length, journalEntryId]
      );
      const reconciliationId = (reconResult as any).insertId;

      await conn.query("UPDATE payments SET reconciliation_id = ? WHERE id IN (?)", [
        reconciliationId,
        selected.map((r) => r.id),
      ]);

      await conn.commit();
      res.status(201).json({ reconciliationId, totalAmount, paymentCount: selected.length });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },

  async history(req: Request, res: Response) {
    const page = req.query.page ? Number(req.query.page) : 1;
    const limit = req.query.limit ? Number(req.query.limit) : 20;

    const [countRows] = await pool.query("SELECT COUNT(*) AS cnt FROM bank_reconciliations");
    const total = (countRows as any[])[0].cnt as number;

    const [rows] = await pool.query(
      `SELECT r.*, a.code AS bank_account_code, a.name AS bank_account_name
       FROM bank_reconciliations r
       JOIN accounts a ON a.id = r.bank_account_id
       ORDER BY r.date DESC, r.id DESC
       LIMIT ? OFFSET ?`,
      [limit, (page - 1) * limit]
    );

    res.json({
      total,
      page,
      limit,
      data: (rows as any[]).map((r) => ({
        id: r.id,
        bankAccountId: r.bank_account_id,
        bankAccountCode: r.bank_account_code,
        bankAccountName: r.bank_account_name,
        date: r.date,
        totalAmount: Number(r.total_amount),
        paymentCount: r.payment_count,
        createdAt: r.created_at,
      })),
    });
  },
};
