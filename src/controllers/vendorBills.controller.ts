import { Request, Response } from "express";
import { PoolConnection } from "mysql2/promise";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { postJournalEntry, WELL_KNOWN_ACCOUNTS, getAccountIdByCode } from "../utils/ledger";

/**
 * Vendor bills -- the accounts-payable side of the books (money the business owes
 * suppliers: fuel, maintenance, insurance, etc.), mirroring invoices.controller.ts's
 * customer-invoice side. Previously nothing in this system ever debited an expense
 * account or credited Accounts Payable -- the P&L's expense side and the balance
 * sheet's AP liability were structurally always zero.
 */
function mapBillRow(row: any) {
  return {
    id: row.id,
    number: row.number,
    vendorId: row.vendor_id,
    vendorName: row.vendor_name,
    billDate: row.bill_date,
    ref: row.ref,
    totalAmount: Number(row.total_amount),
    createdAt: row.created_at,
  };
}

function mapLineRow(row: any) {
  return {
    id: row.id,
    description: row.description,
    accountId: row.account_id,
    vehicleId: row.vehicle_id,
    amount: Number(row.amount),
  };
}

async function nextBillNumber(billDate: string): Promise<string> {
  const year = billDate.slice(0, 4);
  const [rows] = await pool.query("SELECT COUNT(*) AS cnt FROM vendor_bills WHERE number LIKE ?", [`BILL/${year}/%`]);
  const count = (rows as any[])[0].cnt as number;
  return `BILL/${year}/${String(count + 1).padStart(5, "0")}`;
}

export interface CreateVendorBillLineInput {
  description: string;
  accountId: number;
  vehicleId?: number | null;
  amount: number;
}

export interface CreateVendorBillInput {
  vendorId: number;
  billDate: string;
  ref?: string | null;
  lines: CreateVendorBillLineInput[];
}

export async function createVendorBill(input: CreateVendorBillInput) {
  if (!input.lines.length) throw new ApiError(400, "Tagihan harus punya minimal 1 baris");
  const total = input.lines.reduce((sum, l) => sum + l.amount, 0);
  const number = await nextBillNumber(input.billDate);
  const apAccountId = await getAccountIdByCode(WELL_KNOWN_ACCOUNTS.ACCOUNTS_PAYABLE);

  const conn: PoolConnection = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [result] = await conn.query(
      "INSERT INTO vendor_bills (number, vendor_id, bill_date, ref, total_amount) VALUES (?, ?, ?, ?, ?)",
      [number, input.vendorId, input.billDate, input.ref ?? null, total]
    );
    const billId = (result as any).insertId;

    for (const line of input.lines) {
      await conn.query(
        "INSERT INTO vendor_bill_lines (vendor_bill_id, description, account_id, vehicle_id, amount) VALUES (?, ?, ?, ?, ?)",
        [billId, line.description, line.accountId, line.vehicleId ?? null, line.amount]
      );
    }

    await postJournalEntry(
      {
        date: input.billDate,
        ref: number,
        narration: `Tagihan ${number}`,
        sourceType: "vendor_bill",
        sourceId: billId,
        lines: [
          ...input.lines.map((l) => ({ accountId: l.accountId, debit: l.amount, credit: 0 })),
          { accountId: apAccountId, partnerId: input.vendorId, debit: 0, credit: total },
        ],
      },
      conn
    );

    await conn.commit();
    const [rows] = await pool.query(
      "SELECT vb.*, p.name AS vendor_name FROM vendor_bills vb JOIN partners p ON p.id = vb.vendor_id WHERE vb.id = ?",
      [billId]
    );
    return mapBillRow((rows as any[])[0]);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export const vendorBillsController = {
  async list(req: Request, res: Response) {
    const { vendorId } = req.query;
    const page = req.query.page ? Number(req.query.page) : 1;
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (vendorId) {
      clauses.push("vb.vendor_id = ?");
      params.push(vendorId);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const [countRows] = await pool.query(`SELECT COUNT(*) AS cnt FROM vendor_bills vb ${where}`, params);
    const total = (countRows as any[])[0].cnt as number;

    const [rows] = await pool.query(
      `SELECT vb.*, p.name AS vendor_name FROM vendor_bills vb JOIN partners p ON p.id = vb.vendor_id ${where}
       ORDER BY vb.bill_date DESC, vb.id DESC LIMIT ? OFFSET ?`,
      [...params, limit, (page - 1) * limit]
    );
    res.json({ total, page, limit, data: (rows as any[]).map(mapBillRow) });
  },

  async get(req: Request, res: Response) {
    const [rows] = await pool.query(
      "SELECT vb.*, p.name AS vendor_name FROM vendor_bills vb JOIN partners p ON p.id = vb.vendor_id WHERE vb.id = ?",
      [req.params.id]
    );
    const bill = (rows as any[])[0];
    if (!bill) throw new ApiError(404, "Tagihan tidak ditemukan");
    const [lineRows] = await pool.query("SELECT * FROM vendor_bill_lines WHERE vendor_bill_id = ?", [req.params.id]);
    res.json({ ...mapBillRow(bill), lines: (lineRows as any[]).map(mapLineRow) });
  },

  async create(req: Request, res: Response) {
    const { vendorId, billDate, ref, lines } = req.body;
    if (!vendorId || !billDate) throw new ApiError(400, "vendorId dan billDate wajib diisi");
    const bill = await createVendorBill({
      vendorId: Number(vendorId),
      billDate,
      ref,
      lines: (lines ?? []).map((l: any) => ({
        description: l.description,
        accountId: Number(l.accountId),
        vehicleId: l.vehicleId ? Number(l.vehicleId) : null,
        amount: Number(l.amount),
      })),
    });
    res.status(201).json(bill);
  },
};
