import { Request, Response } from "express";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { Invoice, InvoiceLine, InvoiceLineCategory } from "../models/types";
import { postJournalEntry, WELL_KNOWN_ACCOUNTS, getAccountIdByCode } from "../utils/ledger";

function mapInvoiceRow(row: any): Invoice {
  return {
    id: row.id,
    number: row.number,
    partnerId: row.partner_id,
    vehicleId: row.vehicle_id,
    invoiceDate: row.invoice_date,
    state: row.state,
    ref: row.ref,
    totalAmount: Number(row.total_amount),
    createdAt: row.created_at,
  };
}

function mapLineRow(row: any): InvoiceLine {
  return {
    id: row.id,
    invoiceId: row.invoice_id,
    description: row.description,
    category: row.category,
    accountId: row.account_id,
    amount: Number(row.amount),
    taxRate: Number(row.tax_rate),
    taxAmount: Number(row.tax_amount),
  };
}

async function nextInvoiceNumber(invoiceDate: string): Promise<string> {
  const year = invoiceDate.slice(0, 4);
  const [rows] = await pool.query(
    "SELECT COUNT(*) AS cnt FROM invoices WHERE number LIKE ?",
    [`INV/${year}/%`]
  );
  const count = (rows as any[])[0].cnt as number;
  return `INV/${year}/${String(count + 1).padStart(5, "0")}`;
}

export interface CreateInvoiceLineInput {
  description: string;
  category: InvoiceLineCategory;
  accountId: number;
  amount: number;
  /** PPN rate for this line (e.g. 0.11) -- 0 when tax isn't enabled (see
   * utils/settings.ts's ppnEnabled). Off by default: applying 11% to every invoice
   * unconditionally would misstate the books for a non-PKP (non-VAT-registered)
   * business, so this is opt-in per Settings rather than hardcoded. */
  taxRate?: number;
}

export interface CreateInvoiceInput {
  partnerId: number;
  vehicleId: number | null;
  invoiceDate: string;
  ref?: string | null;
  lines: CreateInvoiceLineInput[];
}

/**
 * Create + post an invoice and its journal entry (Debit Piutang Usaha for the total,
 * Credit each line's income account). Returns the created invoice.
 *
 * Idempotency: invoices are unique on (partner_id, vehicle_id, invoice_date) at the DB
 * level (see migration 001). Callers that need idempotent re-import behavior (the Excel
 * importer) should check `findInvoiceByKey` first and skip instead of calling this twice
 * for the same key -- this function itself does not silently upsert.
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function createInvoice(input: CreateInvoiceInput): Promise<Invoice> {
  if (!input.lines.length) throw new ApiError(400, "Invoice harus punya minimal 1 baris");

  const linesWithTax = input.lines.map((l) => ({ ...l, taxAmount: round2(l.amount * (l.taxRate ?? 0)) }));
  const subtotal = linesWithTax.reduce((sum, l) => sum + l.amount, 0);
  const totalTax = linesWithTax.reduce((sum, l) => sum + l.taxAmount, 0);
  const grossTotal = subtotal + totalTax;

  const number = await nextInvoiceNumber(input.invoiceDate);
  const arAccountId = await getAccountIdByCode(WELL_KNOWN_ACCOUNTS.ACCOUNTS_RECEIVABLE);
  const ppnAccountId = totalTax > 0 ? await getAccountIdByCode(WELL_KNOWN_ACCOUNTS.PPN_KELUARAN) : null;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [result] = await conn.query(
      "INSERT INTO invoices (number, partner_id, vehicle_id, invoice_date, state, ref, total_amount) VALUES (?, ?, ?, ?, 'posted', ?, ?)",
      [number, input.partnerId, input.vehicleId, input.invoiceDate, input.ref ?? null, grossTotal]
    );
    const invoiceId = (result as any).insertId;

    for (const line of linesWithTax) {
      await conn.query(
        "INSERT INTO invoice_lines (invoice_id, description, category, account_id, amount, tax_rate, tax_amount) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [invoiceId, line.description, line.category, line.accountId, line.amount, line.taxRate ?? 0, line.taxAmount]
      );
    }

    await postJournalEntry(
      {
        date: input.invoiceDate,
        ref: number,
        narration: `Invoice ${number}`,
        sourceType: "invoice",
        sourceId: invoiceId,
        lines: [
          { accountId: arAccountId, partnerId: input.partnerId, debit: grossTotal, credit: 0 },
          ...linesWithTax.map((l) => ({
            accountId: l.accountId,
            partnerId: input.partnerId,
            debit: 0,
            credit: l.amount,
          })),
          ...(ppnAccountId && totalTax > 0 ? [{ accountId: ppnAccountId, partnerId: input.partnerId, debit: 0, credit: totalTax }] : []),
        ],
      },
      conn
    );

    await conn.commit();

    const [rows] = await pool.query("SELECT * FROM invoices WHERE id = ?", [invoiceId]);
    return mapInvoiceRow((rows as any[])[0]);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function findInvoiceByKey(
  partnerId: number,
  vehicleId: number | null,
  invoiceDate: string
): Promise<Invoice | undefined> {
  const [rows] = await pool.query(
    "SELECT * FROM invoices WHERE partner_id = ? AND vehicle_id <=> ? AND invoice_date = ?",
    [partnerId, vehicleId, invoiceDate]
  );
  const row = (rows as any[])[0];
  return row ? mapInvoiceRow(row) : undefined;
}

export const invoicesController = {
  async list(req: Request, res: Response) {
    const { partnerId, from, to } = req.query;
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (partnerId) {
      clauses.push("partner_id = ?");
      params.push(partnerId);
    }
    if (from) {
      clauses.push("invoice_date >= ?");
      params.push(from);
    }
    if (to) {
      clauses.push("invoice_date <= ?");
      params.push(to);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const [rows] = await pool.query(
      `SELECT * FROM invoices ${where} ORDER BY invoice_date DESC, id DESC LIMIT 500`,
      params
    );
    res.json((rows as any[]).map(mapInvoiceRow));
  },

  async get(req: Request, res: Response) {
    const [rows] = await pool.query("SELECT * FROM invoices WHERE id = ?", [req.params.id]);
    const row = (rows as any[])[0];
    if (!row) throw new ApiError(404, "Invoice tidak ditemukan");
    const [lineRows] = await pool.query("SELECT * FROM invoice_lines WHERE invoice_id = ?", [req.params.id]);
    res.json({ ...mapInvoiceRow(row), lines: (lineRows as any[]).map(mapLineRow) });
  },

  async create(req: Request, res: Response) {
    const { partnerId, vehicleId, invoiceDate, ref, lines } = req.body;
    if (!partnerId || !invoiceDate || !Array.isArray(lines) || !lines.length) {
      throw new ApiError(400, "partnerId, invoiceDate, dan lines wajib diisi");
    }
    const existing = await findInvoiceByKey(partnerId, vehicleId ?? null, invoiceDate);
    if (existing) throw new ApiError(409, `Invoice untuk partner/kendaraan/tanggal ini sudah ada: ${existing.number}`);

    const invoice = await createInvoice({ partnerId, vehicleId: vehicleId ?? null, invoiceDate, ref, lines });
    res.status(201).json(invoice);
  },
};
