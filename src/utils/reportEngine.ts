import { pool } from "../db";
import { Account, AccountType, BusinessUnit } from "../models/types";

export interface AccountBalanceRow {
  account: Account;
  initialBalance: number;
  periodDebit: number;
  periodCredit: number;
  endBalance: number;
}

const CREDIT_NORMAL_TYPES: AccountType[] = ["liability", "equity", "income"];

function signedBalance(type: AccountType, raw: number): number {
  return CREDIT_NORMAL_TYPES.includes(type) ? -raw : raw;
}

/**
 * The one shared aggregation query every report is built on (mirrors how Odoo's own
 * account.report works): for a date range, sum debit/credit per account from
 * `journal_lines`, split into the balance carried in before `from` (initialBalance)
 * and the movement within [from, to] (periodDebit/periodCredit), landing on
 * endBalance = balance as of `to`. Debit-normal types (asset, expense) report the raw
 * debit-minus-credit balance; credit-normal types (liability, equity, income) report
 * the balance sign-flipped so a normal positive balance reads as positive here too.
 */
export async function getAccountBalances(params: {
  from: string;
  to: string;
  types?: AccountType[];
  businessUnit: BusinessUnit;
}): Promise<AccountBalanceRow[]> {
  const { from, to, types, businessUnit } = params;
  const clauses: string[] = ["a.business_unit = ?"];
  const args: unknown[] = [businessUnit];

  if (types && types.length) {
    clauses.push(`a.type IN (${types.map(() => "?").join(",")})`);
    args.push(...types);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;

  const sql = `
    SELECT
      a.id, a.code, a.name, a.type, a.parent_id, a.is_active, a.business_unit, a.description,
      a.category_id, a.tax_id, a.access_mode,
      COALESCE(SUM(CASE WHEN je.date < ? THEN jl.debit - jl.credit ELSE 0 END), 0) AS initial_raw,
      COALESCE(SUM(CASE WHEN je.date BETWEEN ? AND ? THEN jl.debit ELSE 0 END), 0) AS period_debit,
      COALESCE(SUM(CASE WHEN je.date BETWEEN ? AND ? THEN jl.credit ELSE 0 END), 0) AS period_credit,
      COALESCE(SUM(CASE WHEN je.date <= ? THEN jl.debit - jl.credit ELSE 0 END), 0) AS end_raw
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl.account_id = a.id
    LEFT JOIN journal_entries je ON je.id = jl.journal_entry_id
    ${where}
    GROUP BY a.id, a.code, a.name, a.type, a.parent_id, a.is_active, a.business_unit, a.description,
      a.category_id, a.tax_id, a.access_mode
    ORDER BY a.code
  `;

  const [rows] = await pool.query(sql, [from, from, to, from, to, to, ...args]);

  return (rows as any[]).map((row) => {
    const account: Account = {
      id: row.id,
      code: row.code,
      name: row.name,
      type: row.type,
      parentId: row.parent_id,
      isActive: !!row.is_active,
      businessUnit: row.business_unit,
      description: row.description,
      categoryId: row.category_id,
      taxId: row.tax_id,
      accessMode: row.access_mode,
    };
    return {
      account,
      initialBalance: signedBalance(row.type, Number(row.initial_raw)),
      periodDebit: Number(row.period_debit),
      periodCredit: Number(row.period_credit),
      endBalance: signedBalance(row.type, Number(row.end_raw)),
    };
  });
}

export interface LedgerLine {
  date: string;
  ref: string | null;
  narration: string | null;
  partnerName: string | null;
  debit: number;
  credit: number;
  /** Cumulative debit-minus-credit balance up to and including this line -- computed
   * in SQL (window function) over the account's full history in range, so it stays
   * correct across pages instead of resetting to 0 on every page after the first. */
  runningBalance: number;
}

/** Line-by-line movement for one account within a date range, for the General Ledger.
 * Paginated -- a single busy account can have tens of thousands of lines. `totalDebit`/
 * `totalCredit`/`endBalance` are aggregated across the *whole* range (not just the
 * current page), so summary cards stay correct regardless of which page is showing. */
export async function getGeneralLedgerLines(
  accountId: number,
  from: string,
  to: string,
  page: number,
  limit: number
): Promise<{ lines: LedgerLine[]; total: number; totalDebit: number; totalCredit: number; endBalance: number }> {
  const [initialRows] = await pool.query(
    `SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS initial
     FROM journal_lines jl
     JOIN journal_entries je ON je.id = jl.journal_entry_id
     WHERE jl.account_id = ? AND je.date < ?`,
    [accountId, from]
  );
  const initial = Number((initialRows as any[])[0].initial);

  const [aggRows] = await pool.query(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(jl.debit), 0) AS total_debit, COALESCE(SUM(jl.credit), 0) AS total_credit
     FROM journal_lines jl
     JOIN journal_entries je ON je.id = jl.journal_entry_id
     WHERE jl.account_id = ? AND je.date BETWEEN ? AND ?`,
    [accountId, from, to]
  );
  const agg = (aggRows as any[])[0];
  const total = Number(agg.cnt);
  const totalDebit = Number(agg.total_debit);
  const totalCredit = Number(agg.total_credit);
  const endBalance = initial + totalDebit - totalCredit;

  const [rows] = await pool.query(
    `SELECT date, ref, narration, partner_name, debit, credit, running_balance FROM (
       SELECT je.date, je.ref, je.narration, p.name AS partner_name, jl.debit, jl.credit, jl.id AS jl_id,
         (? + SUM(jl.debit - jl.credit) OVER (ORDER BY je.date, jl.id)) AS running_balance
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.journal_entry_id
       LEFT JOIN partners p ON p.id = jl.partner_id
       WHERE jl.account_id = ? AND je.date BETWEEN ? AND ?
     ) t
     ORDER BY date, jl_id
     LIMIT ? OFFSET ?`,
    [initial, accountId, from, to, limit, (page - 1) * limit]
  );

  const lines = (rows as any[]).map((r) => ({
    date: r.date,
    ref: r.ref,
    narration: r.narration,
    partnerName: r.partner_name,
    debit: Number(r.debit),
    credit: Number(r.credit),
    runningBalance: Number(r.running_balance),
  }));

  return { lines, total, totalDebit, totalCredit, endBalance };
}
