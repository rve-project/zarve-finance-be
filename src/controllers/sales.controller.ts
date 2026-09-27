import { Request, Response } from "express";
import { PoolConnection } from "mysql2/promise";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { postJournalEntry, getAccountIdByCode } from "../utils/ledger";
import { adjustWarehouseStock } from "../utils/warehouseStock";

/**
 * "Penjualan" (Sales) -- mirrors purchases.controller.ts's pipeline but for the
 * revenue side: Penawaran -> Pesanan -> Faktur (the only stage that posts to the
 * ledger) -> Pengiriman, plus Tukar Faktur as a side document. Only "invoice" moves
 * money; the rest are workflow/paperwork stages. See migrations/039_sales.sql for why
 * this is a separate table from purchase_documents rather than a shared one with a
 * direction flag, and 045_sale_products.sql for the Produk-based line model -- a
 * line's income account is resolved from its product (sale_account_id), not typed in
 * directly, matching the reference screens.
 */

export type SaleDocType = "quotation" | "order" | "invoice" | "shipment" | "exchange";
export type SaleStatus = "draft" | "pending_approval" | "approved" | "rejected";

const DOC_TYPES: SaleDocType[] = ["quotation", "order", "invoice", "shipment", "exchange"];
const NUMBER_PREFIX: Record<SaleDocType, string> = {
  quotation: "SQ",
  order: "SO",
  invoice: "SINV",
  shipment: "SSH",
  exchange: "SEX",
};

const B2B_ACCOUNTS = {
  ACCOUNTS_RECEIVABLE: "1-10100", // Piutang Usaha -- fallback when the customer has no mapped receivable account
  PPN_KELUARAN: "2-20500", // output VAT -- a liability owed to the tax office, not income
  DISKON_PENJUALAN: "4-40100", // Diskon Penjualan -- discount given reduces revenue, debited as contra-revenue
  RETUR_PENJUALAN: "4-40200", // contra-revenue debited when a Tukar Faktur credits an invoice
};

// Mirrors purchases.controller.ts's PAID_AND_CREDITED_SQL: an invoice's outstanding
// balance is reduced by both real payments and any approved exchange (credit note)
// lines that target it.
const PAID_AND_CREDITED_SQL = `
       (SELECT COALESCE(SUM(amount), 0) FROM sale_payments WHERE document_id = sd.id) AS total_paid,
       (SELECT COALESCE(SUM(sdl.amount), 0) FROM sale_document_lines sdl
          JOIN sale_documents ex ON ex.id = sdl.document_id
          WHERE sdl.target_document_id = sd.id AND ex.status = 'approved') AS total_credited`;

function mapRow(row: any) {
  const totalPaid = Number(row.total_paid ?? 0);
  const totalCredited = Number(row.total_credited ?? 0);
  const total = Number(row.total_amount);
  const outstanding = Math.max(total - totalPaid - totalCredited, 0);
  return {
    id: row.id,
    docType: row.doc_type,
    number: row.number,
    status: row.status,
    contactId: row.contact_id,
    contactName: row.contact_name,
    documentDate: row.document_date,
    dueDate: row.due_date,
    reference: row.reference,
    memo: row.memo,
    email: row.email,
    billingAddress: row.billing_address,
    customerRef: row.customer_ref,
    tag: row.tag,
    customerNote: row.customer_note,
    paymentTerm: row.payment_term,
    warehouseId: row.warehouse_id,
    warehouseName: row.warehouse_name,
    discountAmount: Number(row.discount_amount ?? 0),
    subtotal: Number(row.subtotal),
    taxTotal: Number(row.tax_total),
    totalAmount: total,
    amountPaid: totalPaid,
    amountCredited: totalCredited,
    outstanding: row.doc_type === "invoice" && row.status === "approved" ? outstanding : 0,
    isOverdue: row.doc_type === "invoice" && row.status === "approved" && row.due_date && row.due_date < row.today_date && outstanding > 0,
    convertedFromId: row.converted_from_id,
    submittedBy: row.submitted_by,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    rejectedReason: row.rejected_reason,
    createdAt: row.created_at,
  };
}

function mapLineRow(row: any) {
  return {
    id: row.id,
    productId: row.product_id,
    productName: row.product_name,
    accountId: row.account_id,
    accountName: row.account_name,
    description: row.description,
    qty: Number(row.qty),
    unitPrice: Number(row.unit_price),
    taxId: row.tax_id,
    taxName: row.tax_name,
    taxRate: row.tax_rate === null || row.tax_rate === undefined ? null : Number(row.tax_rate),
    amount: Number(row.amount),
    taxAmount: Number(row.tax_amount),
    targetDocumentId: row.target_document_id,
    targetDocumentNumber: row.target_document_number ?? null,
  };
}

function mapPaymentRow(row: any) {
  return {
    id: row.id,
    bankAccountId: row.bank_account_id,
    bankAccountName: row.bank_account_name,
    amount: Number(row.amount),
    paymentDate: row.payment_date,
    memo: row.memo,
    createdAt: row.created_at,
  };
}

async function nextNumber(businessUnit: string, docType: SaleDocType, documentDate: string): Promise<string> {
  const year = documentDate.slice(0, 4);
  const prefix = NUMBER_PREFIX[docType];
  const [rows] = await pool.query(
    "SELECT COUNT(*) AS cnt FROM sale_documents WHERE business_unit = ? AND doc_type = ? AND number LIKE ?",
    [businessUnit, docType, `${prefix}/${year}/%`]
  );
  const count = (rows as any[])[0].cnt as number;
  return `${prefix}/${year}/${String(count + 1).padStart(5, "0")}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface SaleLineInput {
  productId?: number | null;
  accountId?: number | null;
  targetDocumentId?: number | null;
  description?: string | null;
  qty: number;
  unitPrice: number;
  taxId?: number | null;
  amount: number;
  taxAmount: number;
}

export interface SaleDocInput {
  contactId?: number | null;
  documentDate: string;
  dueDate?: string | null;
  reference?: string | null;
  memo?: string | null;
  email?: string | null;
  billingAddress?: string | null;
  customerRef?: string | null;
  tag?: string | null;
  customerNote?: string | null;
  paymentTerm?: string | null;
  warehouseId?: number | null;
  discountAmount: number;
  lines: SaleLineInput[];
  submitForApproval: boolean;
}

async function resolveReceivableAccountId(businessUnit: "zarve" | "b2b", contactId?: number | null): Promise<number> {
  if (contactId) {
    const [rows] = await pool.query("SELECT receivable_account_id FROM contacts WHERE id = ?", [contactId]);
    const receivableAccountId = (rows as any[])[0]?.receivable_account_id;
    if (receivableAccountId) return receivableAccountId;
  }
  return getAccountIdByCode(B2B_ACCOUNTS.ACCOUNTS_RECEIVABLE, businessUnit);
}

interface ResolvedLine {
  accountId: number | null;
  amount: number;
  productId: number | null;
  trackInventory: boolean;
}

/** A line that picks a Produk doesn't carry its own accountId -- it's resolved from
 * the product's sale_account_id, same convention purchases.controller.ts uses for the
 * buy side. A line without a product (a manual/non-catalog item) keeps using its own
 * accountId as-is. */
async function resolveLineAccounts(lines: SaleLineInput[]): Promise<ResolvedLine[]> {
  const productIds = [...new Set(lines.filter((l) => l.productId).map((l) => l.productId!))];
  const productsById = new Map<number, any>();
  if (productIds.length) {
    const [rows] = await pool.query("SELECT id, sale_account_id, track_inventory FROM products WHERE id IN (?)", [productIds]);
    for (const row of rows as any[]) productsById.set(row.id, row);
  }

  return lines.map((line) => {
    if (line.productId) {
      const product = productsById.get(line.productId);
      return {
        accountId: product?.sale_account_id ?? line.accountId ?? null,
        amount: line.amount,
        productId: line.productId,
        trackInventory: !!product?.track_inventory,
      };
    }
    return { accountId: line.accountId ?? null, amount: line.amount, productId: null, trackInventory: false };
  });
}

/** Posts the invoice's journal entry: debit the customer's mapped Akun Piutang (or the
 * generic default) for the net total, debit Diskon Penjualan for any discount, credit
 * each line's resolved income account, credit PPN Keluaran for the tax total. */
async function postInvoiceJournal(
  businessUnit: "zarve" | "b2b",
  doc: { id: number; number: string; documentDate: string; contactId: number | null; taxTotal: number; totalAmount: number; discountAmount: number },
  resolvedLines: ResolvedLine[],
  conn: PoolConnection
) {
  const receivableAccountId = await resolveReceivableAccountId(businessUnit, doc.contactId);
  const ppnKeluaranId = doc.taxTotal > 0 ? await getAccountIdByCode(B2B_ACCOUNTS.PPN_KELUARAN, businessUnit) : null;
  const diskonPenjualanId =
    doc.discountAmount > 0 ? await getAccountIdByCode(B2B_ACCOUNTS.DISKON_PENJUALAN, businessUnit) : null;

  await postJournalEntry(
    {
      date: doc.documentDate,
      ref: doc.number,
      narration: `Faktur Penjualan ${doc.number}`,
      sourceType: "sale_invoice",
      sourceId: doc.id,
      businessUnit,
      lines: [
        { accountId: receivableAccountId, partnerId: doc.contactId, debit: doc.totalAmount, credit: 0 },
        ...(diskonPenjualanId && doc.discountAmount > 0 ? [{ accountId: diskonPenjualanId, debit: doc.discountAmount, credit: 0 }] : []),
        ...resolvedLines.filter((l) => l.accountId).map((l) => ({ accountId: l.accountId!, debit: 0, credit: l.amount })),
        ...(ppnKeluaranId && doc.taxTotal > 0 ? [{ accountId: ppnKeluaranId, debit: 0, credit: doc.taxTotal }] : []),
      ],
    },
    conn
  );
}

async function getDocumentById(id: number) {
  const [rows] = await pool.query(
    `SELECT sd.*, c.name AS contact_name, w.name AS warehouse_name, CURDATE() AS today_date,${PAID_AND_CREDITED_SQL}
     FROM sale_documents sd
     LEFT JOIN contacts c ON c.id = sd.contact_id
     LEFT JOIN warehouses w ON w.id = sd.warehouse_id
     WHERE sd.id = ?`,
    [id]
  );
  const row = (rows as any[])[0];
  if (!row) throw new ApiError(404, "Dokumen penjualan tidak ditemukan");
  const [lineRows] = await pool.query(
    `SELECT sdl.*, p.name AS product_name, a.name AS account_name, t.name AS tax_name, t.rate AS tax_rate,
       target.number AS target_document_number
     FROM sale_document_lines sdl
     LEFT JOIN products p ON p.id = sdl.product_id
     LEFT JOIN accounts a ON a.id = sdl.account_id
     LEFT JOIN taxes t ON t.id = sdl.tax_id
     LEFT JOIN sale_documents target ON target.id = sdl.target_document_id
     WHERE sdl.document_id = ?`,
    [id]
  );
  const [paymentRows] = await pool.query(
    `SELECT sp.*, a.name AS bank_account_name FROM sale_payments sp JOIN accounts a ON a.id = sp.bank_account_id WHERE sp.document_id = ? ORDER BY sp.payment_date`,
    [id]
  );
  const [journalRows] = await pool.query(
    "SELECT id FROM journal_entries WHERE source_type = 'sale_invoice' AND source_id = ?",
    [id]
  );
  return {
    ...mapRow(row),
    journalEntryId: (journalRows as any[])[0]?.id ?? null,
    lines: (lineRows as any[]).map(mapLineRow),
    payments: (paymentRows as any[]).map(mapPaymentRow),
  };
}

function computeTotals(lines: SaleLineInput[], discountAmount: number) {
  const subtotal = round2(lines.reduce((sum, l) => sum + l.amount, 0));
  const taxTotal = round2(lines.reduce((sum, l) => sum + l.taxAmount, 0));
  const total = Math.max(round2(subtotal + taxTotal - discountAmount), 0);
  return { subtotal, taxTotal, total };
}

export const salesController = {
  async list(req: Request, res: Response) {
    const docType = req.query.docType as string | undefined;
    const status = req.query.status as string | undefined;
    const contactId = req.query.contactId as string | undefined;
    const clauses: string[] = ["sd.business_unit = ?"];
    const params: unknown[] = [req.businessUnit];
    if (docType && DOC_TYPES.includes(docType as SaleDocType)) {
      clauses.push("sd.doc_type = ?");
      params.push(docType);
    }
    if (status) {
      clauses.push("sd.status = ?");
      params.push(status);
    }
    if (contactId) {
      clauses.push("sd.contact_id = ?");
      params.push(Number(contactId));
    }
    const [rows] = await pool.query(
      `SELECT sd.*, c.name AS contact_name, w.name AS warehouse_name, CURDATE() AS today_date,${PAID_AND_CREDITED_SQL}
       FROM sale_documents sd
       LEFT JOIN contacts c ON c.id = sd.contact_id
       LEFT JOIN warehouses w ON w.id = sd.warehouse_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY sd.document_date DESC, sd.id DESC`,
      params
    );
    res.json((rows as any[]).map(mapRow));
  },

  async stats(req: Request, res: Response) {
    const last30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const [rows] = await pool.query(
      `SELECT sd.due_date, sd.total_amount, CURDATE() AS today_date,${PAID_AND_CREDITED_SQL}
       FROM sale_documents sd
       WHERE sd.business_unit = ? AND sd.doc_type = 'invoice' AND sd.status = 'approved'`,
      [req.businessUnit]
    );
    let unpaidTotal = 0;
    let overdueTotal = 0;
    for (const row of rows as any[]) {
      const outstanding = Number(row.total_amount) - Number(row.total_paid) - Number(row.total_credited ?? 0);
      if (outstanding <= 0) continue;
      unpaidTotal += outstanding;
      if (row.due_date && row.due_date < row.today_date) overdueTotal += outstanding;
    }
    const [paidRows] = await pool.query(
      `SELECT COALESCE(SUM(sp.amount), 0) AS total
       FROM sale_payments sp JOIN sale_documents sd ON sd.id = sp.document_id
       WHERE sd.business_unit = ? AND sp.payment_date >= ?`,
      [req.businessUnit, last30]
    );
    res.json({
      unpaidTotal,
      overdueTotal,
      last30PaidTotal: Number((paidRows as any[])[0].total),
    });
  },

  async get(req: Request, res: Response) {
    res.json(await getDocumentById(Number(req.params.id)));
  },

  async create(req: Request, res: Response) {
    const input = parseSaleInput(req.body);
    const docType = req.body.docType as SaleDocType;
    if (!DOC_TYPES.includes(docType)) throw new ApiError(400, "Tipe dokumen tidak valid");

    const totals = computeTotals(input.lines, input.discountAmount);
    const number = await nextNumber(req.businessUnit, docType, input.documentDate);
    const status: SaleStatus = input.submitForApproval ? "pending_approval" : "draft";

    const [result] = await pool.query(
      `INSERT INTO sale_documents
         (business_unit, doc_type, number, status, contact_id, document_date, due_date, reference, memo,
          email, billing_address, customer_ref, tag, customer_note, payment_term, warehouse_id, discount_amount,
          subtotal, tax_total, total_amount, submitted_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.businessUnit,
        docType,
        number,
        status,
        input.contactId ?? null,
        input.documentDate,
        input.dueDate ?? null,
        input.reference ?? null,
        input.memo ?? null,
        input.email ?? null,
        input.billingAddress ?? null,
        input.customerRef ?? null,
        input.tag ?? null,
        input.customerNote ?? null,
        input.paymentTerm ?? null,
        input.warehouseId ?? null,
        input.discountAmount,
        totals.subtotal,
        totals.taxTotal,
        totals.total,
        input.submitForApproval ? req.authUser!.id : null,
      ]
    );
    const docId = (result as any).insertId;
    await insertLines(docId, input.lines);

    res.status(201).json(await getDocumentById(docId));
  },

  async update(req: Request, res: Response) {
    const id = Number(req.params.id);
    const [existingRows] = await pool.query("SELECT * FROM sale_documents WHERE id = ?", [id]);
    const existing = (existingRows as any[])[0];
    if (!existing || existing.business_unit !== req.businessUnit) throw new ApiError(404, "Dokumen penjualan tidak ditemukan");
    if (existing.status !== "draft" && existing.status !== "rejected") {
      throw new ApiError(400, "Hanya dokumen draft atau ditolak yang bisa diubah");
    }

    const input = parseSaleInput(req.body);
    const totals = computeTotals(input.lines, input.discountAmount);
    const status: SaleStatus = input.submitForApproval ? "pending_approval" : "draft";

    await pool.query(
      `UPDATE sale_documents SET
         contact_id = ?, document_date = ?, due_date = ?, reference = ?, memo = ?,
         email = ?, billing_address = ?, customer_ref = ?, tag = ?, customer_note = ?, payment_term = ?,
         warehouse_id = ?, discount_amount = ?,
         subtotal = ?, tax_total = ?, total_amount = ?, status = ?, submitted_by = ?,
         rejected_reason = NULL
       WHERE id = ?`,
      [
        input.contactId ?? null,
        input.documentDate,
        input.dueDate ?? null,
        input.reference ?? null,
        input.memo ?? null,
        input.email ?? null,
        input.billingAddress ?? null,
        input.customerRef ?? null,
        input.tag ?? null,
        input.customerNote ?? null,
        input.paymentTerm ?? null,
        input.warehouseId ?? null,
        input.discountAmount,
        totals.subtotal,
        totals.taxTotal,
        totals.total,
        status,
        input.submitForApproval ? req.authUser!.id : null,
        id,
      ]
    );
    await pool.query("DELETE FROM sale_document_lines WHERE document_id = ?", [id]);
    await insertLines(id, input.lines);

    res.json(await getDocumentById(id));
  },

  async remove(req: Request, res: Response) {
    const id = Number(req.params.id);
    const [existingRows] = await pool.query("SELECT * FROM sale_documents WHERE id = ?", [id]);
    const existing = (existingRows as any[])[0];
    if (!existing || existing.business_unit !== req.businessUnit) throw new ApiError(404, "Dokumen penjualan tidak ditemukan");
    if (existing.status === "approved") throw new ApiError(400, "Dokumen yang sudah disetujui tidak bisa dihapus");

    await pool.query("DELETE FROM sale_document_lines WHERE document_id = ?", [id]);
    await pool.query("DELETE FROM sale_payments WHERE document_id = ?", [id]);
    await pool.query("DELETE FROM sale_documents WHERE id = ?", [id]);
    res.status(204).send();
  },

  async submit(req: Request, res: Response) {
    const id = Number(req.params.id);
    const [rows] = await pool.query("SELECT * FROM sale_documents WHERE id = ?", [id]);
    const doc = (rows as any[])[0];
    if (!doc || doc.business_unit !== req.businessUnit) throw new ApiError(404, "Dokumen penjualan tidak ditemukan");
    if (doc.status !== "draft") throw new ApiError(400, "Hanya dokumen draft yang bisa diajukan untuk persetujuan");

    await pool.query("UPDATE sale_documents SET status = 'pending_approval', submitted_by = ? WHERE id = ?", [
      req.authUser!.id,
      id,
    ]);
    res.json(await getDocumentById(id));
  },

  async approve(req: Request, res: Response) {
    const id = Number(req.params.id);
    const [rows] = await pool.query("SELECT * FROM sale_documents WHERE id = ?", [id]);
    const doc = (rows as any[])[0];
    if (!doc || doc.business_unit !== req.businessUnit) throw new ApiError(404, "Dokumen penjualan tidak ditemukan");
    if (doc.status !== "pending_approval") throw new ApiError(400, "Hanya dokumen yang menunggu persetujuan yang bisa disetujui");

    const conn: PoolConnection = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query("UPDATE sale_documents SET status = 'approved', approved_by = ?, approved_at = NOW() WHERE id = ?", [
        req.authUser!.id,
        id,
      ]);

      if (doc.doc_type === "invoice") {
        const [lineRows] = await conn.query(
          "SELECT product_id, account_id, qty, amount, tax_amount FROM sale_document_lines WHERE document_id = ?",
          [id]
        );
        const rawLines = (lineRows as any[]).map((l) => ({
          productId: l.product_id,
          accountId: l.account_id,
          qty: Number(l.qty),
          amount: Number(l.amount),
          taxAmount: Number(l.tax_amount),
          unitPrice: 0,
        }));
        const resolvedLines = await resolveLineAccounts(rawLines);
        await postInvoiceJournal(
          req.businessUnit,
          {
            id: doc.id,
            number: doc.number,
            documentDate: doc.document_date,
            contactId: doc.contact_id,
            taxTotal: Number(doc.tax_total),
            totalAmount: Number(doc.total_amount),
            discountAmount: Number(doc.discount_amount ?? 0),
          },
          resolvedLines,
          conn
        );

        // Goods actually shipped out (this invoice says so) -- remove the sold qty
        // from the chosen Gudang's stock for every line whose product tracks
        // inventory, mirroring purchases' stock increment in the opposite direction.
        if (doc.warehouse_id) {
          for (let i = 0; i < resolvedLines.length; i++) {
            const resolved = resolvedLines[i];
            if (resolved.productId && resolved.trackInventory) {
              await adjustWarehouseStock(resolved.productId, doc.warehouse_id, -rawLines[i].qty, conn);
              await conn.query("UPDATE products SET current_stock = current_stock - ? WHERE id = ?", [rawLines[i].qty, resolved.productId]);
            }
          }
        }
      }

      if (doc.doc_type === "exchange") {
        const receivableAccountId = await resolveReceivableAccountId(req.businessUnit, doc.contact_id);
        const returAccountId = await getAccountIdByCode(B2B_ACCOUNTS.RETUR_PENJUALAN, req.businessUnit);
        await postJournalEntry(
          {
            date: doc.document_date,
            ref: doc.number,
            narration: `Tukar Faktur Penjualan ${doc.number}`,
            sourceType: "sale_invoice",
            sourceId: doc.id,
            businessUnit: req.businessUnit,
            lines: [
              { accountId: returAccountId, debit: Number(doc.total_amount), credit: 0 },
              { accountId: receivableAccountId, partnerId: doc.contact_id, debit: 0, credit: Number(doc.total_amount) },
            ],
          },
          conn
        );
      }

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    res.json(await getDocumentById(id));
  },

  async reject(req: Request, res: Response) {
    const id = Number(req.params.id);
    const [rows] = await pool.query("SELECT * FROM sale_documents WHERE id = ?", [id]);
    const doc = (rows as any[])[0];
    if (!doc || doc.business_unit !== req.businessUnit) throw new ApiError(404, "Dokumen penjualan tidak ditemukan");
    if (doc.status !== "pending_approval") throw new ApiError(400, "Hanya dokumen yang menunggu persetujuan yang bisa ditolak");

    await pool.query("UPDATE sale_documents SET status = 'rejected', rejected_reason = ? WHERE id = ?", [
      req.body.reason || null,
      id,
    ]);
    res.json(await getDocumentById(id));
  },

  async convert(req: Request, res: Response) {
    const id = Number(req.params.id);
    const targetType = req.body.targetType as SaleDocType;
    if (!DOC_TYPES.includes(targetType)) throw new ApiError(400, "Tipe dokumen tujuan tidak valid");

    const [rows] = await pool.query("SELECT * FROM sale_documents WHERE id = ?", [id]);
    const doc = (rows as any[])[0];
    if (!doc || doc.business_unit !== req.businessUnit) throw new ApiError(404, "Dokumen penjualan tidak ditemukan");
    if (doc.status !== "approved") throw new ApiError(400, "Hanya dokumen yang sudah disetujui yang bisa dikonversi");

    const [lineRows] = await pool.query(
      "SELECT product_id, account_id, description, qty, unit_price, tax_id, amount, tax_amount FROM sale_document_lines WHERE document_id = ?",
      [id]
    );
    const lines = lineRows as any[];
    const totals = computeTotals(
      lines.map((l) => ({ amount: Number(l.amount), taxAmount: Number(l.tax_amount), qty: Number(l.qty), unitPrice: Number(l.unit_price) })),
      0
    );
    const today = new Date().toISOString().slice(0, 10);
    const number = await nextNumber(req.businessUnit, targetType, today);

    const [result] = await pool.query(
      `INSERT INTO sale_documents
         (business_unit, doc_type, number, status, contact_id, document_date, reference, memo, warehouse_id,
          subtotal, tax_total, total_amount, converted_from_id)
       VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.businessUnit, targetType, number, doc.contact_id, today, doc.number, doc.memo, doc.warehouse_id, totals.subtotal, totals.taxTotal, totals.total, id]
    );
    const newId = (result as any).insertId;
    for (const l of lines) {
      await pool.query(
        "INSERT INTO sale_document_lines (document_id, product_id, account_id, description, qty, unit_price, tax_id, amount, tax_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [newId, l.product_id, l.account_id, l.description, l.qty, l.unit_price, l.tax_id, l.amount, l.tax_amount]
      );
    }

    res.status(201).json(await getDocumentById(newId));
  },

  async addPayment(req: Request, res: Response) {
    const id = Number(req.params.id);
    const [rows] = await pool.query("SELECT * FROM sale_documents WHERE id = ?", [id]);
    const doc = (rows as any[])[0];
    if (!doc || doc.business_unit !== req.businessUnit) throw new ApiError(404, "Dokumen penjualan tidak ditemukan");
    if (doc.doc_type !== "invoice" || doc.status !== "approved") {
      throw new ApiError(400, "Hanya faktur penjualan yang sudah disetujui yang bisa dicatat pembayarannya");
    }

    const { bankAccountId, amount, paymentDate, memo } = req.body;
    if (!bankAccountId || !amount || !paymentDate) throw new ApiError(400, "Akun bayar, jumlah, dan tanggal wajib diisi");

    const receivableAccountId = await resolveReceivableAccountId(req.businessUnit, doc.contact_id);

    const conn: PoolConnection = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.query(
        "INSERT INTO sale_payments (document_id, bank_account_id, amount, payment_date, memo) VALUES (?, ?, ?, ?, ?)",
        [id, Number(bankAccountId), Number(amount), paymentDate, memo || null]
      );
      const paymentId = (result as any).insertId;

      await postJournalEntry(
        {
          date: paymentDate,
          ref: `${doc.number}-PAY${paymentId}`,
          narration: `Pelunasan ${doc.number}`,
          sourceType: "sale_payment",
          sourceId: paymentId,
          businessUnit: req.businessUnit,
          lines: [
            { accountId: Number(bankAccountId), debit: Number(amount), credit: 0 },
            { accountId: receivableAccountId, partnerId: doc.contact_id, debit: 0, credit: Number(amount) },
          ],
        },
        conn
      );

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    res.status(201).json(await getDocumentById(id));
  },
};

async function insertLines(documentId: number, lines: SaleLineInput[]) {
  for (const line of lines) {
    await pool.query(
      "INSERT INTO sale_document_lines (document_id, product_id, account_id, target_document_id, description, qty, unit_price, tax_id, amount, tax_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        documentId,
        line.productId ?? null,
        line.accountId ?? null,
        line.targetDocumentId ?? null,
        line.description ?? null,
        line.qty,
        line.unitPrice,
        line.taxId ?? null,
        line.amount,
        line.taxAmount,
      ]
    );
  }
}

function parseSaleInput(body: any): SaleDocInput {
  const {
    contactId,
    documentDate,
    dueDate,
    reference,
    memo,
    email,
    billingAddress,
    customerRef,
    tag,
    customerNote,
    paymentTerm,
    warehouseId,
    discountAmount,
    lines,
    submitForApproval,
  } = body;
  if (!documentDate) throw new ApiError(400, "Tanggal dokumen wajib diisi");
  if (!Array.isArray(lines) || !lines.length) throw new ApiError(400, "Minimal 1 baris wajib diisi");

  return {
    contactId: contactId ? Number(contactId) : null,
    documentDate,
    dueDate: dueDate || null,
    reference: reference || null,
    memo: memo || null,
    email: email || null,
    billingAddress: billingAddress || null,
    customerRef: customerRef || null,
    tag: tag || null,
    customerNote: customerNote || null,
    paymentTerm: paymentTerm || null,
    warehouseId: warehouseId ? Number(warehouseId) : null,
    discountAmount: Number(discountAmount) || 0,
    submitForApproval: !!submitForApproval,
    lines: lines.map((l: any) => ({
      productId: l.productId ? Number(l.productId) : null,
      accountId: l.accountId ? Number(l.accountId) : null,
      targetDocumentId: l.targetDocumentId ? Number(l.targetDocumentId) : null,
      description: l.description || null,
      qty: Number(l.qty) || 1,
      unitPrice: Number(l.unitPrice) || 0,
      taxId: l.taxId ? Number(l.taxId) : null,
      amount: Number(l.amount) || 0,
      taxAmount: Number(l.taxAmount) || 0,
    })),
  };
}
