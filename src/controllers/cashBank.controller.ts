import { Request, Response } from "express";
import * as XLSX from "xlsx";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { WELL_KNOWN_ACCOUNTS } from "../utils/ledger";

/**
 * "Kas & Bank" overview: for each cash/bank account (asset, code prefix '11', same
 * convention as reconciliation.controller.ts and reports.controller.ts's cashFlow),
 * shows "Saldo di Jurnal" (the real ledger balance -- always accurate) next to
 * "Saldo bank" (whatever was last imported from a bank statement file -- see
 * importStatement below). There's no live bank connection in this app; the two
 * figures only agree once someone imports a statement and/or reconciles.
 */

const CASH_BANK_WHERE = "a.business_unit = ? AND a.type = 'asset' AND a.code LIKE '11%' AND a.code != ?";

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
       WHERE ${CASH_BANK_WHERE} AND je.date > ? AND je.date <= ?`,
      [req.businessUnit, WELL_KNOWN_ACCOUNTS.UNDEPOSITED_FUNDS, today, in30Days]
    );
    const future = (futureRows as any[])[0];

    const [balanceRows] = await pool.query(
      `SELECT a.id, COALESCE(SUM(CASE WHEN je.date <= ? THEN jl.debit - jl.credit ELSE 0 END), 0) AS saldo
       FROM accounts a
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
