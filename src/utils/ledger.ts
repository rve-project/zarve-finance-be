import { PoolConnection } from "mysql2/promise";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { JournalSourceType } from "../models/types";

export interface JournalLineInput {
  accountId: number;
  partnerId?: number | null;
  debit: number;
  credit: number;
  analyticTag?: string | null;
}

export interface PostJournalEntryInput {
  date: string;
  ref?: string | null;
  narration?: string | null;
  sourceType: JournalSourceType;
  sourceId?: number | null;
  lines: JournalLineInput[];
}

/** Round to cents to avoid floating point noise before the balance check below. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Post a balanced double-entry journal entry. Every invoice/payment in this system
 * writes one of these -- it's the single source of truth all reports aggregate over.
 * Throws if debits don't equal credits (a bug upstream, not a user input problem).
 */
export async function postJournalEntry(
  input: PostJournalEntryInput,
  conn?: PoolConnection
): Promise<number> {
  const totalDebit = round2(input.lines.reduce((sum, l) => sum + l.debit, 0));
  const totalCredit = round2(input.lines.reduce((sum, l) => sum + l.credit, 0));
  if (totalDebit !== totalCredit) {
    throw new ApiError(
      500,
      `Journal entry tidak balance: debit ${totalDebit} != kredit ${totalCredit} (ref: ${input.ref ?? "-"})`
    );
  }

  const runner = conn ?? pool;

  const [result] = await runner.query(
    "INSERT INTO journal_entries (date, ref, narration, source_type, source_id) VALUES (?, ?, ?, ?, ?)",
    [input.date, input.ref ?? null, input.narration ?? null, input.sourceType, input.sourceId ?? null]
  );
  const journalEntryId = (result as any).insertId;

  for (const line of input.lines) {
    await runner.query(
      "INSERT INTO journal_lines (journal_entry_id, account_id, partner_id, debit, credit, analytic_tag) VALUES (?, ?, ?, ?, ?, ?)",
      [journalEntryId, line.accountId, line.partnerId ?? null, line.debit, line.credit, line.analyticTag ?? null]
    );
  }

  return journalEntryId;
}

let accountIdCache = new Map<string, number>();

export async function getAccountIdByCode(code: string): Promise<number> {
  if (accountIdCache.has(code)) return accountIdCache.get(code)!;
  const [rows] = await pool.query("SELECT id FROM accounts WHERE code = ?", [code]);
  const row = (rows as any[])[0];
  if (!row) throw new ApiError(500, `Akun dengan kode ${code} tidak ditemukan di chart of accounts`);
  accountIdCache.set(code, row.id);
  return row.id;
}

export function clearAccountIdCache() {
  accountIdCache = new Map();
}

// Well-known accounts used by the invoice/payment posting logic.
export const WELL_KNOWN_ACCOUNTS = {
  ACCOUNTS_RECEIVABLE: "1201",
  UNDEPOSITED_FUNDS: "1101002",
  DEFAULT_RENTAL_INCOME: "410103",
  ACCOUNTS_PAYABLE: "2101",
  PPN_KELUARAN: "2303",
  OPENING_BALANCE_EQUITY: "3103",
};
