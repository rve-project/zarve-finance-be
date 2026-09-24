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
    accountCode: row.account_code,
    accountName: row.account_name,
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
    const [rows] = await pool.query(
      `SELECT i.*, p.name AS partner_name, v.plate_number AS vehicle_plate_number,
         COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id = i.id), 0) AS amount_paid
       FROM invoices i
       JOIN partners p ON p.id = i.partner_id
       LEFT JOIN vehicles v ON v.id = i.vehicle_id
       WHERE i.id = ?`,
      [req.params.id]
    );
    const row = (rows as any[])[0];
    if (!row) throw new ApiError(404, "Invoice tidak ditemukan");
    const [lineRows] = await pool.query(
      `SELECT il.*, a.code AS account_code, a.name AS account_name
       FROM invoice_lines il
       JOIN accounts a ON a.id = il.account_id
       WHERE il.invoice_id = ?`,
      [req.params.id]
    );
    // This invoice is a monthly recap (see zarveSync.controller.ts) -- one local line
    // stands in for a whole month of the driver's individual daily Zarve invoices, so
    // its own number never matches anything the driver/staff sees in Zarve. Reconstruct
    // the underlying Zarve invoices by matching driver name + vehicle plate + the
    // invoice's own month, upper-bounded by whichever is earlier: the end of that
    // month, or this recap's own creation date. Both bounds matter -- a month synced
    // mid-way through (created_at falls inside it) must stop there since only days up
    // to that point had contributed to the total yet; a month synced late, as a
    // catch-up run well after it ended (created_at falls in a LATER month), must still
    // stop at that month's own last day, or the range leaks into whichever later month
    // the catch-up run happened to land in and pulls in unrelated invoices.
    //
    // Only show source invoices that are actually still outstanding (total >
    // amount_paid), not the whole month's daily invoices -- a driver who paid on time
    // has ~30 PAID daily invoices behind one recap, and showing all of them next to a
    // small "Sisa" made the list look like a data bug ("sisa 600rb tapi riwayat banyak
    // banget") when in fact only 1-2 of those days were actually unpaid. This also
    // means we don't need to filter by zi.status (which keeps moving after sync time,
    // see findInvoiceByKey's skip-if-exists behavior) -- total > amount_paid reflects
    // Zarve's current reality directly regardless of which status label is attached.
    //
    // vehicle_plate/driver_name are stripped of spaces AND tabs/newlines before
    // comparing: some rows mirrored from Zarve carry a literal tab character glued to
    // the plate (e.g. "\t B 1061 FNS"), which silently broke the space-only REPLACE
    // and made the match return zero rows for those invoices.
    const [sourceRows] = await pool.query(
      `SELECT zi.id, zi.invoice_number, zi.invoice_date, zi.total, zi.amount_paid, zi.status
       FROM zarve_invoices zi
       WHERE REPLACE(REPLACE(REPLACE(REPLACE(UPPER(zi.driver_name), ' ', ''), CHAR(9), ''), CHAR(13), ''), CHAR(10), '')
             = REPLACE(REPLACE(REPLACE(REPLACE(UPPER(?), ' ', ''), CHAR(9), ''), CHAR(13), ''), CHAR(10), '')
         AND REPLACE(REPLACE(REPLACE(REPLACE(UPPER(zi.vehicle_plate), ' ', ''), CHAR(9), ''), CHAR(13), ''), CHAR(10), '')
             = REPLACE(REPLACE(REPLACE(REPLACE(UPPER(?), ' ', ''), CHAR(9), ''), CHAR(13), ''), CHAR(10), '')
         AND zi.type = 'DAILY'
         AND zi.invoice_date >= DATE_FORMAT(?, '%Y-%m-01')
         AND zi.invoice_date <= LEAST(LAST_DAY(?), DATE(?))
         AND zi.total > zi.amount_paid
       ORDER BY zi.invoice_date`,
      [row.partner_name, row.ref ?? row.vehicle_plate_number ?? "", row.invoice_date, row.invoice_date, row.created_at]
    );

    const amountPaid = Number(row.amount_paid);
    res.json({
      ...mapInvoiceRow(row),
      partnerName: row.partner_name,
      vehiclePlateNumber: row.vehicle_plate_number,
      amountPaid,
      outstanding: Math.max(Number(row.total_amount) - amountPaid, 0),
      lines: (lineRows as any[]).map(mapLineRow),
      sourceInvoices: (sourceRows as any[]).map((r) => ({
        zarveInvoiceId: r.id,
        invoiceNumber: r.invoice_number,
        invoiceDate: r.invoice_date,
        total: Number(r.total),
        amountPaid: Number(r.amount_paid),
        status: r.status,
      })),
    });
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
