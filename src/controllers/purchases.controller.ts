import { Request, Response } from "express";
import { PoolConnection } from "mysql2/promise";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { postJournalEntry, getAccountIdByCode } from "../utils/ledger";
import { adjustWarehouseStock } from "../utils/warehouseStock";

/**
 * "Pembelian" (Purchases) -- the full procurement pipeline (Permintaan -> Penawaran ->
 * Pemesanan -> Faktur, plus Tukar Faktur and Pengiriman as side documents), matching
 * the reference screen. Only "invoice" posts to the ledger; the others are workflow/
 * paperwork stages that don't move money until they become an invoice. See
 * migrations/038_purchases.sql for why one table backs all six doc types, and
 * 040_purchase_products.sql for the line-item-picks-a-Produk model added after the
 * "Buat Faktur Pembelian" reference screen -- a line's account/inventory effect is
 * resolved from its product (purchase_account_id / inventory_account_id), not typed in
 * directly, matching how the reference has no "Akun" column at all.
 */

export type PurchaseDocType = "request" | "quotation" | "order" | "invoice" | "exchange" | "shipment";
export type PurchaseStatus = "draft" | "pending_approval" | "approved" | "rejected";

const DOC_TYPES: PurchaseDocType[] = ["request", "quotation", "order", "invoice", "exchange", "shipment"];
const NUMBER_PREFIX: Record<PurchaseDocType, string> = {
  request: "PR",
  quotation: "PQ",
  order: "PO",
  invoice: "PINV",
  exchange: "PEX",
  shipment: "PSH",
};

const B2B_ACCOUNTS = {
  ACCOUNTS_PAYABLE: "2-20100", // Hutang Usaha -- fallback when the supplier has no mapped payable account
  PPN_MASUKAN: "1-10500", // input VAT -- an asset, reclaimable, not an expense
  DISKON_PEMBELIAN: "5-50100", // Diskon Pembelian -- discount received reduces COGS, same account expenses.controller.ts uses
  RETUR_PEMBELIAN: "5-50200", // Retur Pembelian -- a purchase exchange/credit note reduces COGS the same way
};

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
    supplierRef: row.supplier_ref,
    tag: row.tag,
    customerNote: row.customer_note,
    paymentTerm: row.payment_term,
    warehouseId: row.warehouse_id,
    warehouseName: row.warehouse_name,
    discountAmount: Number(row.discount_amount ?? 0),
    approverUserId: row.approver_user_id,
    approverEmail: row.approver_email,
    urgency: row.urgency,
    budgetYear: row.budget_year,
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
    targetDocumentNumber: row.target_document_number,
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

async function nextNumber(businessUnit: string, docType: PurchaseDocType, documentDate: string): Promise<string> {
  const year = documentDate.slice(0, 4);
  const prefix = NUMBER_PREFIX[docType];
  const [rows] = await pool.query(
    "SELECT COUNT(*) AS cnt FROM purchase_documents WHERE business_unit = ? AND doc_type = ? AND number LIKE ?",
    [businessUnit, docType, `${prefix}/${year}/%`]
  );
  const count = (rows as any[])[0].cnt as number;
  return `${prefix}/${year}/${String(count + 1).padStart(5, "0")}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface PurchaseLineInput {
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

export interface PurchaseDocInput {
  contactId?: number | null;
  documentDate: string;
  dueDate?: string | null;
  reference?: string | null;
  memo?: string | null;
  email?: string | null;
  billingAddress?: string | null;
  supplierRef?: string | null;
  tag?: string | null;
  customerNote?: string | null;
  paymentTerm?: string | null;
  warehouseId?: number | null;
  approverUserId?: number | null;
  approverEmail?: string | null;
  urgency?: string | null;
  budgetYear?: string | null;
  discountAmount: number;
  lines: PurchaseLineInput[];
  submitForApproval: boolean;
}

// Reused by list/get/stats: how much of an invoice's total has already been settled --
// real cash (purchase_payments) plus non-cash credit applied by an approved "Tukar
// Faktur" targeting it (see 042_purchase_exchange.sql).
const PAID_AND_CREDITED_SQL = `
  (SELECT COALESCE(SUM(amount), 0) FROM purchase_payments WHERE document_id = pd.id) AS total_paid,
  (SELECT COALESCE(SUM(pdl.amount), 0) FROM purchase_document_lines pdl
     JOIN purchase_documents ex ON ex.id = pdl.document_id
     WHERE pdl.target_document_id = pd.id AND ex.status = 'approved') AS total_credited`;

async function resolvePayableAccountId(businessUnit: "zarve" | "b2b", contactId?: number | null): Promise<number> {
  if (contactId) {
    const [rows] = await pool.query("SELECT payable_account_id FROM contacts WHERE id = ?", [contactId]);
    const payableAccountId = (rows as any[])[0]?.payable_account_id;
    if (payableAccountId) return payableAccountId;
  }
  return getAccountIdByCode(B2B_ACCOUNTS.ACCOUNTS_PAYABLE, businessUnit);
}

interface ResolvedLine {
  accountId: number | null;
  amount: number;
  productId: number | null;
  trackInventory: boolean;
}

/** A line that picks a Produk doesn't carry its own accountId -- it's resolved from
 * the product (inventory account if this product tracks stock, otherwise its purchase/
 * expense account), same convention products.controller.ts uses elsewhere. A line
 * without a product (a manual/non-catalog item) keeps using its own accountId as-is. */
async function resolveLineAccounts(lines: PurchaseLineInput[]): Promise<ResolvedLine[]> {
  const productIds = [...new Set(lines.filter((l) => l.productId).map((l) => l.productId!))];
  const productsById = new Map<number, any>();
  if (productIds.length) {
    const [rows] = await pool.query("SELECT id, purchase_account_id, inventory_account_id, track_inventory FROM products WHERE id IN (?)", [
      productIds,
    ]);
    for (const row of rows as any[]) productsById.set(row.id, row);
  }

  return lines.map((line) => {
    if (line.productId) {
      const product = productsById.get(line.productId);
      const trackInventory = !!product?.track_inventory;
      const accountId = trackInventory ? product?.inventory_account_id : product?.purchase_account_id;
      return { accountId: accountId ?? line.accountId ?? null, amount: line.amount, productId: line.productId, trackInventory };
    }
    return { accountId: line.accountId ?? null, amount: line.amount, productId: null, trackInventory: false };
  });
}

/** Posts the invoice's journal entry: debit each line's resolved account, debit PPN
 * Masukan for the tax total, credit Diskon Pembelian for any discount, credit the
 * supplier's mapped Akun Hutang (or the generic default) for the net total. */
async function postInvoiceJournal(
  businessUnit: "zarve" | "b2b",
  doc: { id: number; number: string; documentDate: string; contactId: number | null; taxTotal: number; totalAmount: number; discountAmount: number },
  resolvedLines: ResolvedLine[],
  conn: PoolConnection
) {
  const payableAccountId = await resolvePayableAccountId(businessUnit, doc.contactId);
  const ppnMasukanId = doc.taxTotal > 0 ? await getAccountIdByCode(B2B_ACCOUNTS.PPN_MASUKAN, businessUnit) : null;
  const diskonPembelianId =
    doc.discountAmount > 0 ? await getAccountIdByCode(B2B_ACCOUNTS.DISKON_PEMBELIAN, businessUnit) : null;

  await postJournalEntry(
    {
      date: doc.documentDate,
      ref: doc.number,
      narration: `Faktur Pembelian ${doc.number}`,
      sourceType: "purchase_invoice",
      sourceId: doc.id,
      businessUnit,
      lines: [
        ...resolvedLines.filter((l) => l.accountId).map((l) => ({ accountId: l.accountId!, debit: l.amount, credit: 0 })),
        ...(ppnMasukanId && doc.taxTotal > 0 ? [{ accountId: ppnMasukanId, debit: doc.taxTotal, credit: 0 }] : []),
        ...(diskonPembelianId && doc.discountAmount > 0
          ? [{ accountId: diskonPembelianId, debit: 0, credit: doc.discountAmount }]
          : []),
        { accountId: payableAccountId, partnerId: doc.contactId, debit: 0, credit: doc.totalAmount },
      ],
    },
    conn
  );
}

async function getDocumentById(id: number) {
  const [rows] = await pool.query(
    `SELECT pd.*, c.name AS contact_name, w.name AS warehouse_name, CURDATE() AS today_date,
       ${PAID_AND_CREDITED_SQL}
     FROM purchase_documents pd
     LEFT JOIN contacts c ON c.id = pd.contact_id
     LEFT JOIN warehouses w ON w.id = pd.warehouse_id
     WHERE pd.id = ?`,
    [id]
  );
  const row = (rows as any[])[0];
  if (!row) throw new ApiError(404, "Dokumen pembelian tidak ditemukan");
  const [lineRows] = await pool.query(
    `SELECT pdl.*, p.name AS product_name, a.name AS account_name, t.name AS tax_name, t.rate AS tax_rate,
       target.number AS target_document_number
     FROM purchase_document_lines pdl
     LEFT JOIN products p ON p.id = pdl.product_id
     LEFT JOIN accounts a ON a.id = pdl.account_id
     LEFT JOIN taxes t ON t.id = pdl.tax_id
     LEFT JOIN purchase_documents target ON target.id = pdl.target_document_id
     WHERE pdl.document_id = ?`,
    [id]
  );
  const [paymentRows] = await pool.query(
    `SELECT pp.*, a.name AS bank_account_name FROM purchase_payments pp JOIN accounts a ON a.id = pp.bank_account_id WHERE pp.document_id = ? ORDER BY pp.payment_date`,
    [id]
  );
  const [journalRows] = await pool.query(
    "SELECT id FROM journal_entries WHERE source_type = 'purchase_invoice' AND source_id = ?",
    [id]
  );
  return {
    ...mapRow(row),
    journalEntryId: (journalRows as any[])[0]?.id ?? null,
    lines: (lineRows as any[]).map(mapLineRow),
    payments: (paymentRows as any[]).map(mapPaymentRow),
  };
}

function computeTotals(lines: PurchaseLineInput[], discountAmount: number) {
  const subtotal = round2(lines.reduce((sum, l) => sum + l.amount, 0));
  const taxTotal = round2(lines.reduce((sum, l) => sum + l.taxAmount, 0));
  const total = Math.max(round2(subtotal + taxTotal - discountAmount), 0);
  return { subtotal, taxTotal, total };
}

export const purchasesController = {
  async list(req: Request, res: Response) {
    const docType = req.query.docType as string | undefined;
    const status = req.query.status as string | undefined;
    const contactId = req.query.contactId as string | undefined;
    const clauses: string[] = ["pd.business_unit = ?"];
    const params: unknown[] = [req.businessUnit];
    if (docType && DOC_TYPES.includes(docType as PurchaseDocType)) {
      clauses.push("pd.doc_type = ?");
      params.push(docType);
    }
    if (status) {
      clauses.push("pd.status = ?");
      params.push(status);
    }
    if (contactId) {
      clauses.push("pd.contact_id = ?");
      params.push(Number(contactId));
    }
    const [rows] = await pool.query(
      `SELECT pd.*, c.name AS contact_name, w.name AS warehouse_name, CURDATE() AS today_date,
         ${PAID_AND_CREDITED_SQL}
       FROM purchase_documents pd
       LEFT JOIN contacts c ON c.id = pd.contact_id
       LEFT JOIN warehouses w ON w.id = pd.warehouse_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY pd.document_date DESC, pd.id DESC`,
      params
    );
    res.json((rows as any[]).map(mapRow));
  },

  async stats(req: Request, res: Response) {
    const last30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const [rows] = await pool.query(
      `SELECT pd.due_date, pd.total_amount, CURDATE() AS today_date,
         ${PAID_AND_CREDITED_SQL}
       FROM purchase_documents pd
       WHERE pd.business_unit = ? AND pd.doc_type = 'invoice' AND pd.status = 'approved'`,
      [req.businessUnit]
    );
    let unpaidTotal = 0;
    let overdueTotal = 0;
    for (const row of rows as any[]) {
      const outstanding = Number(row.total_amount) - Number(row.total_paid) - Number(row.total_credited);
      if (outstanding <= 0) continue;
      unpaidTotal += outstanding;
      if (row.due_date && row.due_date < row.today_date) overdueTotal += outstanding;
    }
    const [paidRows] = await pool.query(
      `SELECT COALESCE(SUM(pp.amount), 0) AS total
       FROM purchase_payments pp JOIN purchase_documents pd ON pd.id = pp.document_id
       WHERE pd.business_unit = ? AND pp.payment_date >= ?`,
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
    const input = parsePurchaseInput(req.body);
    const docType = req.body.docType as PurchaseDocType;
    if (!DOC_TYPES.includes(docType)) throw new ApiError(400, "Tipe dokumen tidak valid");

    const totals = computeTotals(input.lines, input.discountAmount);
    const number = await nextNumber(req.businessUnit, docType, input.documentDate);
    const status: PurchaseStatus = input.submitForApproval ? "pending_approval" : "draft";

    const [result] = await pool.query(
      `INSERT INTO purchase_documents
         (business_unit, doc_type, number, status, contact_id, document_date, due_date, reference, memo,
          email, billing_address, supplier_ref, tag, customer_note, payment_term, warehouse_id, discount_amount,
          approver_user_id, approver_email, urgency, budget_year,
          subtotal, tax_total, total_amount, submitted_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.supplierRef ?? null,
        input.tag ?? null,
        input.customerNote ?? null,
        input.paymentTerm ?? null,
        input.warehouseId ?? null,
        input.discountAmount,
        input.approverUserId ?? null,
        input.approverEmail ?? null,
        input.urgency ?? null,
        input.budgetYear ?? null,
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
    const [existingRows] = await pool.query("SELECT * FROM purchase_documents WHERE id = ?", [id]);
    const existing = (existingRows as any[])[0];
    if (!existing || existing.business_unit !== req.businessUnit) throw new ApiError(404, "Dokumen pembelian tidak ditemukan");
    if (existing.status !== "draft" && existing.status !== "rejected") {
      throw new ApiError(400, "Hanya dokumen draft atau ditolak yang bisa diubah");
    }

    const input = parsePurchaseInput(req.body);
    const totals = computeTotals(input.lines, input.discountAmount);
    const status: PurchaseStatus = input.submitForApproval ? "pending_approval" : "draft";

    await pool.query(
      `UPDATE purchase_documents SET
         contact_id = ?, document_date = ?, due_date = ?, reference = ?, memo = ?,
         email = ?, billing_address = ?, supplier_ref = ?, tag = ?, customer_note = ?, payment_term = ?,
         warehouse_id = ?, discount_amount = ?,
         approver_user_id = ?, approver_email = ?, urgency = ?, budget_year = ?,
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
        input.supplierRef ?? null,
        input.tag ?? null,
        input.customerNote ?? null,
        input.paymentTerm ?? null,
        input.warehouseId ?? null,
        input.discountAmount,
        input.approverUserId ?? null,
        input.approverEmail ?? null,
        input.urgency ?? null,
        input.budgetYear ?? null,
        totals.subtotal,
        totals.taxTotal,
        totals.total,
        status,
        input.submitForApproval ? req.authUser!.id : null,
        id,
      ]
    );
    await pool.query("DELETE FROM purchase_document_lines WHERE document_id = ?", [id]);
    await insertLines(id, input.lines);

    res.json(await getDocumentById(id));
  },

  async remove(req: Request, res: Response) {
    const id = Number(req.params.id);
    const [existingRows] = await pool.query("SELECT * FROM purchase_documents WHERE id = ?", [id]);
    const existing = (existingRows as any[])[0];
    if (!existing || existing.business_unit !== req.businessUnit) throw new ApiError(404, "Dokumen pembelian tidak ditemukan");
    if (existing.status === "approved") throw new ApiError(400, "Dokumen yang sudah disetujui tidak bisa dihapus");

    await pool.query("DELETE FROM purchase_document_lines WHERE document_id = ?", [id]);
    await pool.query("DELETE FROM purchase_payments WHERE document_id = ?", [id]);
    await pool.query("DELETE FROM purchase_documents WHERE id = ?", [id]);
    res.status(204).send();
  },

  async submit(req: Request, res: Response) {
    const id = Number(req.params.id);
    const [rows] = await pool.query("SELECT * FROM purchase_documents WHERE id = ?", [id]);
    const doc = (rows as any[])[0];
    if (!doc || doc.business_unit !== req.businessUnit) throw new ApiError(404, "Dokumen pembelian tidak ditemukan");
    if (doc.status !== "draft") throw new ApiError(400, "Hanya dokumen draft yang bisa diajukan untuk persetujuan");

    await pool.query("UPDATE purchase_documents SET status = 'pending_approval', submitted_by = ? WHERE id = ?", [
      req.authUser!.id,
      id,
    ]);
    res.json(await getDocumentById(id));
  },

  async approve(req: Request, res: Response) {
    const id = Number(req.params.id);
    const [rows] = await pool.query("SELECT * FROM purchase_documents WHERE id = ?", [id]);
    const doc = (rows as any[])[0];
    if (!doc || doc.business_unit !== req.businessUnit) throw new ApiError(404, "Dokumen pembelian tidak ditemukan");
    if (doc.status !== "pending_approval") throw new ApiError(400, "Hanya dokumen yang menunggu persetujuan yang bisa disetujui");

    const conn: PoolConnection = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query("UPDATE purchase_documents SET status = 'approved', approved_by = ?, approved_at = NOW() WHERE id = ?", [
        req.authUser!.id,
        id,
      ]);

      if (doc.doc_type === "invoice") {
        const [lineRows] = await conn.query(
          "SELECT product_id, account_id, qty, amount, tax_amount FROM purchase_document_lines WHERE document_id = ?",
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

        // Goods actually arrived (this invoice says so) -- add the ordered qty to the
        // chosen Gudang's stock for every line whose product tracks inventory. A
        // service/product without inventory tracking (or a manual non-catalog line)
        // has nothing to add.
        if (doc.warehouse_id) {
          for (let i = 0; i < resolvedLines.length; i++) {
            const resolved = resolvedLines[i];
            if (resolved.productId && resolved.trackInventory) {
              await adjustWarehouseStock(resolved.productId, doc.warehouse_id, rawLines[i].qty, conn);
              await conn.query("UPDATE products SET current_stock = current_stock + ? WHERE id = ?", [rawLines[i].qty, resolved.productId]);
            }
          }
        }
      }

      if (doc.doc_type === "exchange") {
        const payableAccountId = await resolvePayableAccountId(req.businessUnit, doc.contact_id);
        const returAccountId = await getAccountIdByCode(B2B_ACCOUNTS.RETUR_PEMBELIAN, req.businessUnit);
        await postJournalEntry(
          {
            date: doc.document_date,
            ref: doc.number,
            narration: `Tukar Faktur Pembelian ${doc.number}`,
            sourceType: "purchase_invoice",
            sourceId: doc.id,
            businessUnit: req.businessUnit,
            lines: [
              { accountId: payableAccountId, partnerId: doc.contact_id, debit: Number(doc.total_amount), credit: 0 },
              { accountId: returAccountId, debit: 0, credit: Number(doc.total_amount) },
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
    const [rows] = await pool.query("SELECT * FROM purchase_documents WHERE id = ?", [id]);
    const doc = (rows as any[])[0];
    if (!doc || doc.business_unit !== req.businessUnit) throw new ApiError(404, "Dokumen pembelian tidak ditemukan");
    if (doc.status !== "pending_approval") throw new ApiError(400, "Hanya dokumen yang menunggu persetujuan yang bisa ditolak");

    await pool.query("UPDATE purchase_documents SET status = 'rejected', rejected_reason = ? WHERE id = ?", [
      req.body.reason || null,
      id,
    ]);
    res.json(await getDocumentById(id));
  },

  async convert(req: Request, res: Response) {
    const id = Number(req.params.id);
    const targetType = req.body.targetType as PurchaseDocType;
    if (!DOC_TYPES.includes(targetType)) throw new ApiError(400, "Tipe dokumen tujuan tidak valid");

    const [rows] = await pool.query("SELECT * FROM purchase_documents WHERE id = ?", [id]);
    const doc = (rows as any[])[0];
    if (!doc || doc.business_unit !== req.businessUnit) throw new ApiError(404, "Dokumen pembelian tidak ditemukan");
    if (doc.status !== "approved") throw new ApiError(400, "Hanya dokumen yang sudah disetujui yang bisa dikonversi");

    const [lineRows] = await pool.query(
      "SELECT product_id, account_id, description, qty, unit_price, tax_id, amount, tax_amount FROM purchase_document_lines WHERE document_id = ?",
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
      `INSERT INTO purchase_documents
         (business_unit, doc_type, number, status, contact_id, document_date, reference, memo, warehouse_id,
          subtotal, tax_total, total_amount, converted_from_id)
       VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.businessUnit, targetType, number, doc.contact_id, today, doc.number, doc.memo, doc.warehouse_id, totals.subtotal, totals.taxTotal, totals.total, id]
    );
    const newId = (result as any).insertId;
    for (const l of lines) {
      await pool.query(
        "INSERT INTO purchase_document_lines (document_id, product_id, account_id, description, qty, unit_price, tax_id, amount, tax_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [newId, l.product_id, l.account_id, l.description, l.qty, l.unit_price, l.tax_id, l.amount, l.tax_amount]
      );
    }

    res.status(201).json(await getDocumentById(newId));
  },

  async addPayment(req: Request, res: Response) {
    const id = Number(req.params.id);
    const [rows] = await pool.query("SELECT * FROM purchase_documents WHERE id = ?", [id]);
    const doc = (rows as any[])[0];
    if (!doc || doc.business_unit !== req.businessUnit) throw new ApiError(404, "Dokumen pembelian tidak ditemukan");
    if (doc.doc_type !== "invoice" || doc.status !== "approved") {
      throw new ApiError(400, "Hanya faktur pembelian yang sudah disetujui yang bisa dicatat pembayarannya");
    }

    const { bankAccountId, amount, paymentDate, memo } = req.body;
    if (!bankAccountId || !amount || !paymentDate) throw new ApiError(400, "Akun bayar, jumlah, dan tanggal wajib diisi");

    const payableAccountId = await resolvePayableAccountId(req.businessUnit, doc.contact_id);

    const conn: PoolConnection = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.query(
        "INSERT INTO purchase_payments (document_id, bank_account_id, amount, payment_date, memo) VALUES (?, ?, ?, ?, ?)",
        [id, Number(bankAccountId), Number(amount), paymentDate, memo || null]
      );
      const paymentId = (result as any).insertId;

      await postJournalEntry(
        {
          date: paymentDate,
          ref: `${doc.number}-PAY${paymentId}`,
          narration: `Pembayaran ${doc.number}`,
          sourceType: "purchase_payment",
          sourceId: paymentId,
          businessUnit: req.businessUnit,
          lines: [
            { accountId: payableAccountId, partnerId: doc.contact_id, debit: Number(amount), credit: 0 },
            { accountId: Number(bankAccountId), debit: 0, credit: Number(amount) },
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

async function insertLines(documentId: number, lines: PurchaseLineInput[]) {
  for (const line of lines) {
    await pool.query(
      "INSERT INTO purchase_document_lines (document_id, product_id, account_id, target_document_id, description, qty, unit_price, tax_id, amount, tax_amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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

function parsePurchaseInput(body: any): PurchaseDocInput {
  const {
    contactId,
    documentDate,
    dueDate,
    reference,
    memo,
    email,
    billingAddress,
    supplierRef,
    tag,
    customerNote,
    paymentTerm,
    warehouseId,
    approverUserId,
    approverEmail,
    urgency,
    budgetYear,
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
    supplierRef: supplierRef || null,
    tag: tag || null,
    customerNote: customerNote || null,
    paymentTerm: paymentTerm || null,
    warehouseId: warehouseId ? Number(warehouseId) : null,
    approverUserId: approverUserId ? Number(approverUserId) : null,
    approverEmail: approverEmail || null,
    urgency: urgency || null,
    budgetYear: budgetYear || null,
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
