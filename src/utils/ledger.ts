import { PoolConnection } from "mysql2/promise";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { BusinessUnit, JournalSourceType } from "../models/types";

export interface JournalLineInput {
  accountId: number;
  partnerId?: number | null;
  debit: number;
  credit: number;
  analyticTag?: string | null;
  description?: string | null;
}

export interface PostJournalEntryInput {
  date: string;
  ref?: string | null;
  narration?: string | null;
  sourceType: JournalSourceType;
  sourceId?: number | null;
  /** Defaults to "zarve" -- every existing caller (invoices, payments, vendor bills,
   * vendor payments, reconciliation) posts exclusively to the Zarve business and needs
   * no change. Only the manual Jurnal Entries screen passes this explicitly, since
   * it's the one posting path usable by either business unit. */
  businessUnit?: BusinessUnit;
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
    "INSERT INTO journal_entries (date, ref, narration, source_type, source_id, business_unit) VALUES (?, ?, ?, ?, ?, ?)",
    [input.date, input.ref ?? null, input.narration ?? null, input.sourceType, input.sourceId ?? null, input.businessUnit ?? "zarve"]
  );
  const journalEntryId = (result as any).insertId;

  for (const line of input.lines) {
    await runner.query(
      "INSERT INTO journal_lines (journal_entry_id, account_id, partner_id, debit, credit, analytic_tag, description) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [journalEntryId, line.accountId, line.partnerId ?? null, line.debit, line.credit, line.analyticTag ?? null, line.description ?? null]
    );
  }

  return journalEntryId;
}

/**
 * Groups a document's per-line tax amounts by each line's own tax code, resolving each
 * group to that tax code's configured "akun penampung" (taxes.account_id, see migration
 * 052_tax_account.sql) instead of lumping every tax into one hardcoded PPN account
 * regardless of which tax code was actually picked (e.g. PPN 11% vs PPH 23 2% need
 * different accounts). A tax code with no account configured, or a line with no taxId
 * at all, falls back to `defaultAccountCode` -- so existing tax codes nobody has set an
 * account for yet behave exactly like before this feature existed.
 *
 * A "pajak gabungan" (compound tax, see migration 053_compound_taxes.sql) is a single
 * tax_id that's actually a bundle of 2+ component taxes -- e.g. "PPN 11% + PPH 23 2%",
 * whose own `rate` is the signed sum (11 - 2 = 9) so every OTHER computation in the app
 * (the amount/taxAmount math in ExpenseForm/SaleForm/PurchaseForm) needs no changes at
 * all. Only posting needs to know about the individual components: each one's share is
 * recomputed from the line's own `amount` (the base/DPP) x the component's rate, signed
 * +1 ("add", e.g. PPN -- follows the same direction every other tax already posts in)
 * or -1 ("subtract", e.g. PPH 23 withheld -- posts in the OPPOSITE direction, to its own
 * payable account, since it reduces what's actually paid rather than adding to it).
 * Everything is netted per account (in case two different lines' taxes somehow resolve
 * to the same account with opposite signs) before the caller decides debit vs credit.
 *
 * Returns one entry per resolved account (already netted), ready to spread into
 * postJournalEntry's lines -- `sign: 1` posts in the document type's normal tax
 * direction (credit for sales' PPN Keluaran, debit for purchases/expenses' PPN
 * Masukan), `sign: -1` posts in the opposite direction.
 */
export async function resolveTaxJournalLines(
  lines: { taxId?: number | null; amount: number; taxAmount: number }[],
  defaultAccountCode: string,
  businessUnit: BusinessUnit
): Promise<{ accountId: number; amount: number; sign: 1 | -1 }[]> {
  const taxed = lines.filter((l) => l.taxId || l.taxAmount !== 0);
  if (!taxed.length) return [];

  const taxIds = [...new Set(taxed.map((l) => l.taxId).filter((id): id is number => !!id))];
  const taxById = new Map<number, { isCompound: boolean; accountId: number | null }>();
  if (taxIds.length) {
    const [rows] = await pool.query("SELECT id, is_compound, account_id FROM taxes WHERE id IN (?)", [taxIds]);
    for (const row of rows as any[]) taxById.set(row.id, { isCompound: !!row.is_compound, accountId: row.account_id });
  }

  const compoundIds = [...taxById.entries()].filter(([, t]) => t.isCompound).map(([id]) => id);
  const componentsByGroup = new Map<number, { accountId: number | null; rate: number; sign: "add" | "subtract" }[]>();
  if (compoundIds.length) {
    const [rows] = await pool.query(
      `SELECT tc.group_tax_id, tc.sign, t.account_id, t.rate
       FROM tax_components tc
       JOIN taxes t ON t.id = tc.component_tax_id
       WHERE tc.group_tax_id IN (?)`,
      [compoundIds]
    );
    for (const row of rows as any[]) {
      const list = componentsByGroup.get(row.group_tax_id) ?? [];
      list.push({ accountId: row.account_id, rate: Number(row.rate), sign: row.sign });
      componentsByGroup.set(row.group_tax_id, list);
    }
  }

  const defaultAccountId = await getAccountIdByCode(defaultAccountCode, businessUnit);
  const netByAccount = new Map<number, number>();

  function addNet(accountId: number, signedAmount: number) {
    netByAccount.set(accountId, round2((netByAccount.get(accountId) ?? 0) + signedAmount));
  }

  for (const line of taxed) {
    const tax = line.taxId ? taxById.get(line.taxId) : undefined;
    if (!tax) {
      if (line.taxAmount !== 0) addNet(defaultAccountId, line.taxAmount);
      continue;
    }
    if (!tax.isCompound) {
      addNet(tax.accountId ?? defaultAccountId, line.taxAmount);
      continue;
    }
    for (const component of componentsByGroup.get(line.taxId!) ?? []) {
      const componentAmount = round2(line.amount * (component.rate / 100));
      addNet(component.accountId ?? defaultAccountId, component.sign === "subtract" ? -componentAmount : componentAmount);
    }
  }

  const result: { accountId: number; amount: number; sign: 1 | -1 }[] = [];
  for (const [accountId, net] of netByAccount) {
    if (net === 0) continue;
    result.push({ accountId, amount: Math.abs(net), sign: net > 0 ? 1 : -1 });
  }
  return result;
}

let accountIdCache = new Map<string, number>();

export async function getAccountIdByCode(code: string, businessUnit: BusinessUnit = "zarve"): Promise<number> {
  const cacheKey = `${businessUnit}:${code}`;
  if (accountIdCache.has(cacheKey)) return accountIdCache.get(cacheKey)!;
  const [rows] = await pool.query("SELECT id FROM accounts WHERE code = ? AND business_unit = ?", [code, businessUnit]);
  const row = (rows as any[])[0];
  if (!row) throw new ApiError(500, `Akun dengan kode ${code} tidak ditemukan di chart of accounts`);
  accountIdCache.set(cacheKey, row.id);
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
