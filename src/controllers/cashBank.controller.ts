import { Request, Response } from "express";
import * as XLSX from "xlsx";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { WELL_KNOWN_ACCOUNTS } from "../utils/ledger";

/**
 * "Kas & Bank" overview: for each cash/bank account (identified by its "Cash & Bank"
 * account_categories row -- B2B's codes don't follow a fixed prefix convention like
 * Zarve's do, see reconciliation.controller.ts/reports.controller.ts's cashFlow for
 * that older code-prefix approach, which only ever applied to Zarve), shows "Saldo di
 * Jurnal" (the real ledger balance -- always accurate) next to "Saldo bank" (whatever
 * was last imported from a bank statement file -- see importStatement below). There's
 * no live bank connection in this app; the two figures only agree once someone
 * imports a statement and/or reconciles.
 */

const CASH_BANK_JOIN = "JOIN account_categories cat ON cat.id = a.category_id AND cat.value = 'cash_bank'";
const CASH_BANK_WHERE = "a.business_unit = ? AND a.code != ?";

export const cashBankController = {
  async accounts(req: Request, res: Response) {
    const includeArchived = req.query.includeArchived === "true";
    const activeClause = includeArchived ? "" : "AND a.is_active = TRUE";

    const [rows] = await pool.query(
      `SELECT a.id, a.code, a.name, a.is_active,
         COALESCE(SUM(CASE WHEN je.date <= CURDATE() THEN jl.debit - jl.credit ELSE 0 END), 0) AS saldo_jurnal,
         (
           SELECT bsl.balance FROM bank_statement_lines bsl
           WHERE bsl.account_id = a.id
           ORDER BY bsl.statement_date DESC, bsl.id DESC
           LIMIT 1
         ) AS saldo_bank
       FROM accounts a
       ${CASH_BANK_JOIN}
       LEFT JOIN journal_lines jl ON jl.account_id = a.id
       LEFT JOIN journal_entries je ON je.id = jl.journal_entry_id
       WHERE ${CASH_BANK_WHERE} ${activeClause}
       GROUP BY a.id, a.code, a.name, a.is_active
       ORDER BY a.code`,
      [req.businessUnit, WELL_KNOWN_ACCOUNTS.UNDEPOSITED_FUNDS]
    );

    res.json(
      (rows as any[]).map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        isActive: !!r.is_active,
        saldoJurnal: Number(r.saldo_jurnal),
        saldoBank: r.saldo_bank === null ? 0 : Number(r.saldo_bank),
      }))
    );
  },

  async summary(req: Request, res: Response) {
    const today = new Date().toISOString().slice(0, 10);
    const in30Days = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const [futureRows] = await pool.query(
      `SELECT COALESCE(SUM(jl.debit), 0) AS inflow, COALESCE(SUM(jl.credit), 0) AS outflow,
         COALESCE(SUM(CASE WHEN jl.debit > 0 THEN 1 ELSE 0 END), 0) AS inflow_count,
         COALESCE(SUM(CASE WHEN jl.credit > 0 THEN 1 ELSE 0 END), 0) AS outflow_count
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.journal_entry_id
       JOIN accounts a ON a.id = jl.account_id
       ${CASH_BANK_JOIN}
       WHERE ${CASH_BANK_WHERE} AND je.date > ? AND je.date <= ?`,
      [req.businessUnit, WELL_KNOWN_ACCOUNTS.UNDEPOSITED_FUNDS, today, in30Days]
    );
    const future = (futureRows as any[])[0];

    const [balanceRows] = await pool.query(
      `SELECT a.id, COALESCE(SUM(CASE WHEN je.date <= ? THEN jl.debit - jl.credit ELSE 0 END), 0) AS saldo
       FROM accounts a
       ${CASH_BANK_JOIN}
       LEFT JOIN journal_lines jl ON jl.account_id = a.id
       LEFT JOIN journal_entries je ON je.id = jl.journal_entry_id
       WHERE ${CASH_BANK_WHERE} AND a.is_active = TRUE
       GROUP BY a.id`,
      [today, req.businessUnit, WELL_KNOWN_ACCOUNTS.UNDEPOSITED_FUNDS]
    );
    const balances = balanceRows as any[];

    res.json({
      asOf: today,
      pemasukanMendatang: Number(future.inflow),
      pemasukanMendatangCount: Number(future.inflow_count),
      pengeluaranMendatang: Number(future.outflow),
      pengeluaranMendatangCount: Number(future.outflow_count),
      saldoKasBank: balances.reduce((sum, r) => sum + Number(r.saldo), 0),
      saldoKasBankCount: balances.length,
      // No credit-card account category exists in this chart of accounts yet --
      // always zero until one is modeled. Not a bug, just nothing to report.
      saldoKartuKredit: 0,
      saldoKartuKreditCount: 0,
    });
  },

  /**
   * Full transaction ledger for one cash/bank account (date, a title/subtitle the
   * frontend derives from source_type + doc number, contact name, debit/credit, and a
   * running balance computed via window function -- same technique reportEngine.ts's
   * getGeneralLedgerLines uses for the General Ledger report, just without a date range
   * and with richer source/contact resolution than that shared helper has).
   *
   * Contact name is resolved by walking source_type/source_id back to
   * purchase_documents/sale_documents/expenses (through purchase_payments/
   * sale_payments for the *_payment source types, since their source_id is the
   * payment's own id, not the document's) -- NOT via journal_lines.partner_id, which
   * is a pre-existing FK to Zarve's `partners` table and doesn't hold a B2B contact id
   * correctly. See purchases/sales/expenses controllers, which pass a contacts.id as
   * partnerId; that's a latent bug elsewhere, not something to build on further here.
   */
  async ledger(req: Request, res: Response) {
    const accountId = Number(req.params.accountId);
    const [accountRows] = await pool.query("SELECT * FROM accounts WHERE id = ?", [accountId]);
    const account = (accountRows as any[])[0];
    if (!account || account.business_unit !== req.businessUnit) throw new ApiError(404, "Akun tidak ditemukan");

    const search = (req.query.search as string | undefined)?.trim();
    const page = req.query.page ? Number(req.query.page) : 1;
    const limit = req.query.limit ? Number(req.query.limit) : 25;

    const baseQuery = `
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.journal_entry_id
      LEFT JOIN purchase_documents pd ON je.source_type = 'purchase_invoice' AND pd.id = je.source_id
      LEFT JOIN purchase_payments pp ON je.source_type = 'purchase_payment' AND pp.id = je.source_id
      LEFT JOIN purchase_documents pd2 ON pd2.id = pp.document_id
      LEFT JOIN sale_documents sd ON je.source_type = 'sale_invoice' AND sd.id = je.source_id
      LEFT JOIN sale_payments sp ON je.source_type = 'sale_payment' AND sp.id = je.source_id
      LEFT JOIN sale_documents sd2 ON sd2.id = sp.document_id
      LEFT JOIN expenses ex ON je.source_type = 'expense' AND ex.id = je.source_id
      LEFT JOIN contacts c ON c.id = COALESCE(pd.contact_id, pd2.contact_id, sd.contact_id, sd2.contact_id, ex.contact_id)
      LEFT JOIN partners p ON p.id = jl.partner_id
      WHERE jl.account_id = ?`;

    let searchClause = "";
    const searchParams: unknown[] = [];
    if (search) {
      searchClause = ` AND (je.ref LIKE ? OR je.narration LIKE ? OR jl.description LIKE ? OR
        COALESCE(pd.number, pd2.number, sd.number, sd2.number, ex.number) LIKE ? OR
        COALESCE(c.name, p.name) LIKE ?)`;
      searchParams.push(...Array(5).fill(`%${search}%`));
    }

    const [countRows] = await pool.query(`SELECT COUNT(*) AS cnt ${baseQuery}${searchClause}`, [accountId, ...searchParams]);
    const total = (countRows as any[])[0].cnt as number;

    // The true ending balance is always over this account's whole (unfiltered)
    // history -- a search narrows which rows are *displayed*, not what the account
    // actually holds.
    const [endRows] = await pool.query(`SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS end_balance ${baseQuery}`, [accountId]);

    // Running balance is likewise computed over the full unfiltered history inside the
    // window-function subquery, then the search filter (if any) narrows the outer
    // SELECT afterward -- so a searched-for row still shows its true cumulative
    // balance, not one relative to only the matching rows.
    const [rows] = await pool.query(
      `SELECT * FROM (
         SELECT je.date, je.ref, je.narration, je.source_type, jl.id AS line_id, jl.debit, jl.credit,
           jl.description AS line_description,
           COALESCE(pd.number, pd2.number, sd.number, sd2.number, ex.number) AS doc_number,
           COALESCE(c.name, p.name) AS contact_name,
           CASE
             WHEN pd.id IS NOT NULL OR pd2.id IS NOT NULL THEN 'purchase'
             WHEN sd.id IS NOT NULL OR sd2.id IS NOT NULL THEN 'sale'
             WHEN ex.id IS NOT NULL THEN 'expense'
             ELSE NULL
           END AS doc_kind,
           COALESCE(pd.id, pd2.id, sd.id, sd2.id, ex.id) AS doc_id,
           SUM(jl.debit - jl.credit) OVER (ORDER BY je.date, jl.id) AS running_balance
         ${baseQuery}
       ) t
       ${searchClause ? `WHERE ref LIKE ? OR narration LIKE ? OR line_description LIKE ? OR doc_number LIKE ? OR contact_name LIKE ?` : ""}
       ORDER BY date, line_id
       LIMIT ? OFFSET ?`,
      [accountId, ...searchParams, limit, (page - 1) * limit]
    );

    res.json({
      accountId,
      total,
      page,
      limit,
      endBalance: Number((endRows as any[])[0].end_balance),
      lines: (rows as any[]).map((r) => ({
        lineId: r.line_id,
        date: r.date,
        ref: r.ref,
        narration: r.narration,
        sourceType: r.source_type,
        docNumber: r.doc_number,
        docKind: r.doc_kind,
        docId: r.doc_id,
        lineDescription: r.line_description,
        contactName: r.contact_name,
        debit: Number(r.debit),
        credit: Number(r.credit),
        runningBalance: Number(r.running_balance),
      })),
    });
  },

  async downloadTemplate(_req: Request, res: Response) {
    const worksheet = XLSX.utils.aoa_to_sheet([
      ["Tanggal", "Keterangan", "Debit", "Kredit", "Saldo"],
      ["2026-01-01", "Contoh: Setoran awal", 5000000, 0, 5000000],
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Rekening Koran");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="Template Impor Rekening Koran.xlsx"');
    res.send(buffer);
  },

  /**
   * Imports a bank statement file (own format, since there's no live bank connection):
   * columns Tanggal, Keterangan, Debit, Kredit, Saldo (case-insensitive; Saldo
   * optional -- computed by running debit/credit off the account's last known balance
   * if the file doesn't include it). Stores every line so "Saldo bank" above always
   * reflects the most recently imported statement.
   */
  async importStatement(req: Request, res: Response) {
    const accountId = Number(req.params.accountId);
    const file = req.file;
    if (!file) throw new ApiError(400, "File rekening koran wajib diunggah");

    const [accountRows] = await pool.query("SELECT * FROM accounts WHERE id = ?", [accountId]);
    const account = (accountRows as any[])[0];
    if (!account || account.business_unit !== req.businessUnit) throw new ApiError(404, "Akun tidak ditemukan");

    const workbook = XLSX.read(file.buffer, { type: "buffer", cellDates: true });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });

    function pick(row: Record<string, unknown>, ...keys: string[]): unknown {
      for (const key of Object.keys(row)) {
        if (keys.includes(key.trim().toLowerCase())) return row[key];
      }
      return null;
    }
    function parseDate(value: unknown): string | null {
      if (value instanceof Date) return value.toISOString().slice(0, 10);
      if (typeof value === "string" && value.trim()) {
        const d = new Date(value);
        if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
      }
      return null;
    }

    const parsed = rawRows
      .map((row) => ({
        date: parseDate(pick(row, "tanggal", "date")),
        description: String(pick(row, "keterangan", "deskripsi", "description") ?? ""),
        debit: Number(pick(row, "debit")) || 0,
        credit: Number(pick(row, "kredit", "credit")) || 0,
        rawBalance: pick(row, "saldo", "balance"),
      }))
      .filter((r) => r.date);

    if (!parsed.length) {
      throw new ApiError(400, "Tidak ada baris valid ditemukan -- pastikan file punya kolom Tanggal, Debit, Kredit, Saldo.");
    }

    const [lastLineRows] = await pool.query(
      "SELECT balance FROM bank_statement_lines WHERE account_id = ? ORDER BY statement_date DESC, id DESC LIMIT 1",
      [accountId]
    );
    let runningBalance = (lastLineRows as any[])[0] ? Number((lastLineRows as any[])[0].balance) : 0;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [importResult] = await conn.query(
        "INSERT INTO bank_statement_imports (account_id, file_name, total_lines) VALUES (?, ?, ?)",
        [accountId, file.originalname, parsed.length]
      );
      const importId = (importResult as any).insertId;

      for (const line of parsed) {
        runningBalance =
          line.rawBalance !== null && line.rawBalance !== undefined && line.rawBalance !== ""
            ? Number(line.rawBalance)
            : runningBalance + line.debit - line.credit;

        await conn.query(
          "INSERT INTO bank_statement_lines (import_id, account_id, statement_date, description, debit, credit, balance) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [importId, accountId, line.date, line.description || null, line.debit, line.credit, runningBalance]
        );
      }

      await conn.commit();
      res.status(201).json({ importId, totalLines: parsed.length, endingBalance: runningBalance });
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },
};
