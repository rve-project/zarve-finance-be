import { Request, Response } from "express";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { postJournalEntry, JournalLineInput } from "../utils/ledger";

/**
 * Manual journal entries -- for adjustments, corrections, accruals, depreciation, and
 * opening balances (see accounts.OPENING_BALANCE_EQUITY). Every other posting path in
 * this app (invoices, payments, reconciliation, vendor bills) is fully automatic; this
 * is the one place a real bookkeeper can enter an arbitrary balanced debit/credit
 * entry directly, same as Odoo's "Journal Entries" screen.
 */
function mapEntryRow(row: any) {
  return {
    id: row.id,
    date: row.date,
    ref: row.ref,
    narration: row.narration,
    sourceType: row.source_type,
    sourceId: row.source_id,
    createdAt: row.created_at,
  };
}

function mapLineRow(row: any) {
  return {
    id: row.id,
    accountId: row.account_id,
    accountCode: row.account_code,
    accountName: row.account_name,
    partnerId: row.partner_id,
    partnerName: row.partner_name,
    debit: Number(row.debit),
    credit: Number(row.credit),
  };
}

export const journalEntriesController = {
  async list(req: Request, res: Response) {
    const { from, to } = req.query;
    const page = req.query.page ? Number(req.query.page) : 1;
    const limit = req.query.limit ? Number(req.query.limit) : 20;

    const clauses: string[] = [];
    const params: unknown[] = [];
    if (from) {
      clauses.push("date >= ?");
      params.push(from);
    }
    if (to) {
      clauses.push("date <= ?");
      params.push(to);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const [countRows] = await pool.query(`SELECT COUNT(*) AS cnt FROM journal_entries ${where}`, params);
    const total = (countRows as any[])[0].cnt as number;

    const [rows] = await pool.query(
      `SELECT je.*, COALESCE(SUM(jl.debit), 0) AS total_amount
       FROM journal_entries je
       LEFT JOIN journal_lines jl ON jl.journal_entry_id = je.id
       ${where}
       GROUP BY je.id
       ORDER BY je.date DESC, je.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]
    );

    res.json({
      total,
      page,
      limit,
      data: (rows as any[]).map((r) => ({ ...mapEntryRow(r), totalAmount: Number(r.total_amount) })),
    });
  },

  async get(req: Request, res: Response) {
    const [entryRows] = await pool.query("SELECT * FROM journal_entries WHERE id = ?", [req.params.id]);
    const entry = (entryRows as any[])[0];
    if (!entry) throw new ApiError(404, "Jurnal tidak ditemukan");

    const [lineRows] = await pool.query(
      `SELECT jl.*, a.code AS account_code, a.name AS account_name, p.name AS partner_name
       FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id
       LEFT JOIN partners p ON p.id = jl.partner_id
       WHERE jl.journal_entry_id = ?
       ORDER BY jl.id`,
      [req.params.id]
    );

    res.json({ ...mapEntryRow(entry), lines: (lineRows as any[]).map(mapLineRow) });
  },

  async create(req: Request, res: Response) {
    const { date, ref, narration, lines } = req.body;
    if (!date) throw new ApiError(400, "Tanggal wajib diisi");
    if (!Array.isArray(lines) || lines.length < 2) throw new ApiError(400, "Jurnal wajib punya minimal 2 baris");

    const journalLines: JournalLineInput[] = lines.map((l: any) => ({
      accountId: Number(l.accountId),
      partnerId: l.partnerId ? Number(l.partnerId) : null,
      debit: Number(l.debit) || 0,
      credit: Number(l.credit) || 0,
    }));
    if (journalLines.some((l) => !l.accountId || (l.debit === 0 && l.credit === 0))) {
      throw new ApiError(400, "Setiap baris wajib punya akun dan nilai debit atau kredit");
    }

    // Checked here (not left to postJournalEntry's own check) so a genuine user typo
    // reports as 400 Bad Request -- postJournalEntry's check is a 500 because every
    // other caller builds its own lines internally, where a mismatch really would be
    // our bug, not the user's.
    const totalDebit = Math.round(journalLines.reduce((sum, l) => sum + l.debit, 0) * 100) / 100;
    const totalCredit = Math.round(journalLines.reduce((sum, l) => sum + l.credit, 0) * 100) / 100;
    if (totalDebit !== totalCredit) {
      throw new ApiError(400, `Jurnal tidak balance: debit ${totalDebit} != kredit ${totalCredit}`);
    }

    // postJournalEntry itself throws if debit != credit -- no need to duplicate that check.
    const id = await postJournalEntry({ date, ref: ref ?? null, narration: narration ?? null, sourceType: "manual", lines: journalLines });
    res.status(201).json({ id });
  },

  /** Books a mirror entry (debit/credit swapped) dated today -- undoes a mistaken
   * manual entry without deleting it, preserving the audit trail. */
  async reverse(req: Request, res: Response) {
    const [entryRows] = await pool.query("SELECT * FROM journal_entries WHERE id = ?", [req.params.id]);
    const entry = (entryRows as any[])[0];
    if (!entry) throw new ApiError(404, "Jurnal tidak ditemukan");

    const [lineRows] = await pool.query("SELECT * FROM journal_lines WHERE journal_entry_id = ?", [req.params.id]);
    const lines = lineRows as any[];
    if (!lines.length) throw new ApiError(400, "Jurnal ini tidak punya baris untuk dibalik");

    const reversedLines: JournalLineInput[] = lines.map((l) => ({
      accountId: l.account_id,
      partnerId: l.partner_id,
      debit: Number(l.credit),
      credit: Number(l.debit),
    }));

    const id = await postJournalEntry({
      date: new Date().toISOString().slice(0, 10),
      ref: entry.ref ? `REV-${entry.ref}` : `REV-JE${entry.id}`,
      narration: `Pembalik jurnal #${entry.id}${entry.narration ? ` (${entry.narration})` : ""}`,
      sourceType: "manual",
      lines: reversedLines,
    });
    res.status(201).json({ id });
  },
};
