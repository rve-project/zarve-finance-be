import { Request, Response } from "express";
import { PoolConnection } from "mysql2/promise";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { postJournalEntry, getAccountIdByCode } from "../utils/ledger";

/**
 * "Pengeluaran" (Mekari Jurnal's "Buat Biaya") -- a one-step expense: paid immediately
 * from a chosen Kas & Bank account, or posted to Akun Hutang if "Bayar Nanti" is
 * checked (same liability side as a vendor bill, just without a separate bill+payment
 * two-step flow). B2B-only -- see migration 036_expenses.sql.
 */

// Fixed accounts this feature posts to beyond the user's own line-level "Akun Biaya"
// choices -- codes come straight from the reference chart of accounts (034_full_b2b_coa.sql).
const B2B_ACCOUNTS = {
  ACCOUNTS_PAYABLE: "2-20100", // Hutang Usaha
  PPN_MASUKAN: "1-10500", // input VAT -- an asset, reclaimable, not an expense
  DISKON_PEMBELIAN: "5-50100", // Diskon Pembelian -- discount received reduces COGS
};

function mapRow(row: any) {
  return {
    id: row.id,
    number: row.number,
    contactId: row.contact_id,
    contactName: row.contact_name,
    expenseDate: row.expense_date,
    paymentMethod: row.payment_method,
    bankAccountId: row.bank_account_id,
    bankAccountName: row.bank_account_name,
    payLater: !!row.pay_later,
    billingAddress: row.billing_address,
    tag: row.tag,
    memo: row.memo,
    discountAmount: Number(row.discount_amount),
    totalAmount: Number(row.total_amount),
    outstanding: row.pay_later ? Number(row.total_amount) : 0,
    categoryName: row.category_name,
    createdAt: row.created_at,
  };
}

function mapLineRow(row: any) {
  return {
    id: row.id,
    accountId: row.account_id,
    accountName: row.account_name,
    description: row.description,
    taxId: row.tax_id,
    taxName: row.tax_name,
    taxRate: row.tax_rate === null || row.tax_rate === undefined ? null : Number(row.tax_rate),
    amount: Number(row.amount),
    taxAmount: Number(row.tax_amount),
  };
}

async function nextExpenseNumber(businessUnit: string, expenseDate: string): Promise<string> {
  const year = expenseDate.slice(0, 4);
  const [rows] = await pool.query("SELECT COUNT(*) AS cnt FROM expenses WHERE business_unit = ? AND number LIKE ?", [
    businessUnit,
    `EXP/${year}/%`,
  ]);
  const count = (rows as any[])[0].cnt as number;
  return `EXP/${year}/${String(count + 1).padStart(5, "0")}`;
}

export interface CreateExpenseLineInput {
  accountId: number;
  description?: string | null;
  taxId?: number | null;
  amount: number;
  taxAmount: number;
}

export interface CreateExpenseInput {
  contactId?: number | null;
  expenseDate: string;
  paymentMethod?: string | null;
  bankAccountId?: number | null;
  payLater: boolean;
  billingAddress?: string | null;
  tag?: string | null;
  memo?: string | null;
  discountAmount: number;
  lines: CreateExpenseLineInput[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** "Bayar Nanti" posts to the payee's own mapped Akun Hutang when one's picked (see
 * contacts.controller.ts's "Pemetaan akun") -- a real per-vendor AP sub-ledger instead
 * of dumping every unpaid expense into one shared account. Falls back to the generic
 * default when there's no contact (or the contact's mapping is somehow missing). */
async function resolvePayableAccountId(businessUnit: "zarve" | "b2b", contactId?: number | null): Promise<number> {
  if (contactId) {
    const [rows] = await pool.query("SELECT payable_account_id FROM contacts WHERE id = ?", [contactId]);
    const payableAccountId = (rows as any[])[0]?.payable_account_id;
    if (payableAccountId) return payableAccountId;
  }
  return getAccountIdByCode(B2B_ACCOUNTS.ACCOUNTS_PAYABLE, businessUnit);
}

/** Shared by create and update: validates the input and resolves everything that
 * depends on a database lookup (next number is create-only), so both write paths post
 * an identical journal shape. */
async function resolveExpensePosting(businessUnit: "zarve" | "b2b", input: CreateExpenseInput) {
  if (!input.lines.length) throw new ApiError(400, "Biaya harus punya minimal 1 baris");
  if (!input.payLater && !input.bankAccountId) throw new ApiError(400, "Pilih akun 'Bayar Dari', atau centang 'Bayar Nanti'");

  const linesTotal = input.lines.reduce((sum, l) => sum + l.amount + l.taxAmount, 0);
  const totalTax = input.lines.reduce((sum, l) => sum + l.taxAmount, 0);
  const total = round2(linesTotal - input.discountAmount);
  if (total < 0) throw new ApiError(400, "Jumlah pemotongan tidak boleh lebih besar dari subtotal");

  const creditAccountId = input.payLater
    ? await resolvePayableAccountId(businessUnit, input.contactId)
    : input.bankAccountId!;
  const ppnMasukanId = totalTax > 0 ? await getAccountIdByCode(B2B_ACCOUNTS.PPN_MASUKAN, businessUnit) : null;
  const diskonPembelianId =
    input.discountAmount > 0 ? await getAccountIdByCode(B2B_ACCOUNTS.DISKON_PEMBELIAN, businessUnit) : null;

  return { total, totalTax, creditAccountId, ppnMasukanId, diskonPembelianId };
}

function journalLinesFor(
  input: CreateExpenseInput,
  resolved: { total: number; totalTax: number; creditAccountId: number; ppnMasukanId: number | null; diskonPembelianId: number | null }
) {
  return [
    ...input.lines.map((l) => ({ accountId: l.accountId, debit: l.amount, credit: 0 })),
    ...(resolved.ppnMasukanId && resolved.totalTax > 0 ? [{ accountId: resolved.ppnMasukanId, debit: resolved.totalTax, credit: 0 }] : []),
    ...(resolved.diskonPembelianId && input.discountAmount > 0
      ? [{ accountId: resolved.diskonPembelianId, debit: 0, credit: input.discountAmount }]
      : []),
    { accountId: resolved.creditAccountId, partnerId: input.contactId ?? null, debit: 0, credit: resolved.total },
  ];
}

export async function createExpense(businessUnit: "zarve" | "b2b", input: CreateExpenseInput) {
  const resolved = await resolveExpensePosting(businessUnit, input);
  const number = await nextExpenseNumber(businessUnit, input.expenseDate);

  const conn: PoolConnection = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [result] = await conn.query(
      `INSERT INTO expenses
         (business_unit, number, contact_id, expense_date, payment_method, bank_account_id, pay_later,
          billing_address, tag, memo, discount_amount, total_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        businessUnit,
        number,
        input.contactId ?? null,
        input.expenseDate,
        input.paymentMethod ?? null,
        input.payLater ? null : input.bankAccountId,
        input.payLater,
        input.billingAddress ?? null,
        input.tag ?? null,
        input.memo ?? null,
        input.discountAmount,
        resolved.total,
      ]
    );
    const expenseId = (result as any).insertId;

    for (const line of input.lines) {
      await conn.query(
        "INSERT INTO expense_lines (expense_id, account_id, description, tax_id, amount, tax_amount) VALUES (?, ?, ?, ?, ?, ?)",
        [expenseId, line.accountId, line.description ?? null, line.taxId ?? null, line.amount, line.taxAmount]
      );
    }

    await postJournalEntry(
      {
        date: input.expenseDate,
        ref: number,
        narration: `Biaya ${number}`,
        sourceType: "expense",
        sourceId: expenseId,
        businessUnit,
        lines: journalLinesFor(input, resolved),
      },
      conn
    );

    await conn.commit();
    return await getExpenseById(expenseId);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Re-posts the expense in place: same id/number, but the old journal entry is
 * removed and a fresh balanced one takes its place -- simplest correct way to keep the
 * ledger matching an edited transaction (there's no partial-adjustment concept here,
 * unlike journal-entries' own reverse-only edit policy, since nothing yet references an
 * expense's journal entry besides the expense itself). */
export async function updateExpense(businessUnit: "zarve" | "b2b", id: number, input: CreateExpenseInput) {
  const [existingRows] = await pool.query("SELECT * FROM expenses WHERE id = ?", [id]);
  const existing = (existingRows as any[])[0];
  if (!existing || existing.business_unit !== businessUnit) throw new ApiError(404, "Biaya tidak ditemukan");

  const resolved = await resolveExpensePosting(businessUnit, input);

  const conn: PoolConnection = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [oldJournalRows] = await conn.query(
      "SELECT id FROM journal_entries WHERE source_type = 'expense' AND source_id = ?",
      [id]
    );
    const oldJournalId = (oldJournalRows as any[])[0]?.id;
    if (oldJournalId) {
      await conn.query("DELETE FROM journal_lines WHERE journal_entry_id = ?", [oldJournalId]);
      await conn.query("DELETE FROM journal_entries WHERE id = ?", [oldJournalId]);
    }
    await conn.query("DELETE FROM expense_lines WHERE expense_id = ?", [id]);

    await conn.query(
      `UPDATE expenses SET
         contact_id = ?, expense_date = ?, payment_method = ?, bank_account_id = ?, pay_later = ?,
         billing_address = ?, tag = ?, memo = ?, discount_amount = ?, total_amount = ?
       WHERE id = ?`,
      [
        input.contactId ?? null,
        input.expenseDate,
        input.paymentMethod ?? null,
        input.payLater ? null : input.bankAccountId,
        input.payLater,
        input.billingAddress ?? null,
        input.tag ?? null,
        input.memo ?? null,
        input.discountAmount,
        resolved.total,
        id,
      ]
    );

    for (const line of input.lines) {
      await conn.query(
        "INSERT INTO expense_lines (expense_id, account_id, description, tax_id, amount, tax_amount) VALUES (?, ?, ?, ?, ?, ?)",
        [id, line.accountId, line.description ?? null, line.taxId ?? null, line.amount, line.taxAmount]
      );
    }

    await postJournalEntry(
      {
        date: input.expenseDate,
        ref: existing.number,
        narration: `Biaya ${existing.number}`,
        sourceType: "expense",
        sourceId: id,
        businessUnit,
        lines: journalLinesFor(input, resolved),
      },
      conn
    );

    await conn.commit();
    return await getExpenseById(id);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function deleteExpense(businessUnit: "zarve" | "b2b", id: number) {
  const [existingRows] = await pool.query("SELECT * FROM expenses WHERE id = ?", [id]);
  const existing = (existingRows as any[])[0];
  if (!existing || existing.business_unit !== businessUnit) throw new ApiError(404, "Biaya tidak ditemukan");

  const conn: PoolConnection = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [journalRows] = await conn.query(
      "SELECT id FROM journal_entries WHERE source_type = 'expense' AND source_id = ?",
      [id]
    );
    const journalId = (journalRows as any[])[0]?.id;
    if (journalId) {
      await conn.query("DELETE FROM journal_lines WHERE journal_entry_id = ?", [journalId]);
      await conn.query("DELETE FROM journal_entries WHERE id = ?", [journalId]);
    }
    await conn.query("DELETE FROM expense_lines WHERE expense_id = ?", [id]);
    await conn.query("DELETE FROM expenses WHERE id = ?", [id]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function getExpenseById(id: number) {
  const [rows] = await pool.query(
    `SELECT e.*, c.name AS contact_name, a.name AS bank_account_name
     FROM expenses e
     LEFT JOIN contacts c ON c.id = e.contact_id
     LEFT JOIN accounts a ON a.id = e.bank_account_id
     WHERE e.id = ?`,
    [id]
  );
  const row = (rows as any[])[0];
  if (!row) throw new ApiError(404, "Biaya tidak ditemukan");
  const [lineRows] = await pool.query(
    `SELECT el.*, a.name AS account_name, t.name AS tax_name, t.rate AS tax_rate
     FROM expense_lines el
     JOIN accounts a ON a.id = el.account_id
     LEFT JOIN taxes t ON t.id = el.tax_id
     WHERE el.expense_id = ?`,
    [id]
  );
  const [journalRows] = await pool.query(
    "SELECT id FROM journal_entries WHERE source_type = 'expense' AND source_id = ?",
    [id]
  );
  return {
    ...mapRow(row),
    journalEntryId: (journalRows as any[])[0]?.id ?? null,
    lines: (lineRows as any[]).map(mapLineRow),
  };
}

export const expensesController = {
  async list(req: Request, res: Response) {
    const [rows] = await pool.query(
      `SELECT e.*, c.name AS contact_name, a.name AS bank_account_name,
         (SELECT ac.name FROM expense_lines el2 JOIN accounts ac ON ac.id = el2.account_id
          WHERE el2.expense_id = e.id ORDER BY el2.id LIMIT 1) AS category_name
       FROM expenses e
       LEFT JOIN contacts c ON c.id = e.contact_id
       LEFT JOIN accounts a ON a.id = e.bank_account_id
       WHERE e.business_unit = ?
       ORDER BY e.expense_date DESC, e.id DESC`,
      [req.businessUnit]
    );
    res.json((rows as any[]).map(mapRow));
  },

  async stats(req: Request, res: Response) {
    const monthStart = new Date();
    monthStart.setDate(1);
    const monthStartStr = monthStart.toISOString().slice(0, 10);
    const last30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const [monthRows] = await pool.query(
      "SELECT COUNT(*) AS cnt, COALESCE(SUM(total_amount), 0) AS total FROM expenses WHERE business_unit = ? AND expense_date >= ?",
      [req.businessUnit, monthStartStr]
    );
    const [last30Rows] = await pool.query(
      "SELECT COUNT(*) AS cnt, COALESCE(SUM(total_amount), 0) AS total FROM expenses WHERE business_unit = ? AND expense_date >= ?",
      [req.businessUnit, last30]
    );
    const [unpaidRows] = await pool.query(
      "SELECT COUNT(*) AS cnt, COALESCE(SUM(total_amount), 0) AS total FROM expenses WHERE business_unit = ? AND pay_later = TRUE",
      [req.businessUnit]
    );

    const month = (monthRows as any[])[0];
    const last30Row = (last30Rows as any[])[0];
    const unpaid = (unpaidRows as any[])[0];
    res.json({
      monthTotal: Number(month.total),
      monthCount: Number(month.cnt),
      last30Total: Number(last30Row.total),
      last30Count: Number(last30Row.cnt),
      unpaidTotal: Number(unpaid.total),
      unpaidCount: Number(unpaid.cnt),
    });
  },

  async get(req: Request, res: Response) {
    res.json(await getExpenseById(Number(req.params.id)));
  },

  async create(req: Request, res: Response) {
    const expense = await createExpense(req.businessUnit, parseExpenseInput(req.body));
    res.status(201).json(expense);
  },

  async update(req: Request, res: Response) {
    const expense = await updateExpense(req.businessUnit, Number(req.params.id), parseExpenseInput(req.body));
    res.json(expense);
  },

  async remove(req: Request, res: Response) {
    await deleteExpense(req.businessUnit, Number(req.params.id));
    res.status(204).send();
  },
};

function parseExpenseInput(body: any): CreateExpenseInput {
  const { contactId, expenseDate, paymentMethod, bankAccountId, payLater, billingAddress, tag, memo, discountAmount, lines } = body;
  if (!expenseDate) throw new ApiError(400, "Tanggal transaksi wajib diisi");
  if (!Array.isArray(lines) || !lines.length) throw new ApiError(400, "Minimal 1 baris akun biaya wajib diisi");

  return {
    contactId: contactId ? Number(contactId) : null,
    expenseDate,
    paymentMethod: paymentMethod || null,
    bankAccountId: bankAccountId ? Number(bankAccountId) : null,
    payLater: !!payLater,
    billingAddress: billingAddress || null,
    tag: tag || null,
    memo: memo || null,
    discountAmount: Number(discountAmount) || 0,
    lines: lines.map((l: any) => ({
      accountId: Number(l.accountId),
      description: l.description || null,
      taxId: l.taxId ? Number(l.taxId) : null,
      amount: Number(l.amount) || 0,
      taxAmount: Number(l.taxAmount) || 0,
    })),
  };
}
