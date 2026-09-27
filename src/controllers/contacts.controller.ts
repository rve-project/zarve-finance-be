import { Request, Response } from "express";
import { PoolConnection } from "mysql2/promise";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { ContactType } from "../models/types";
import { getAccountIdByCode } from "../utils/ledger";

/**
 * "Kontak" -- Pelanggan/Supplier/Karyawan/Lainnya, matching Mekari's Kontak screen. A
 * separate table from `partners` (see migrations/032_contacts.sql, extended in
 * 037_contact_details.sql). "Saldo" is always 0 -- no AR/AP balance tracking exists for
 * B2B yet, this only routes which account a transaction posts to (see
 * expenses.controller.ts's payLater path), not an actual running balance per contact.
 */

const CONTACT_TYPES: ContactType[] = ["customer", "vendor", "employee", "other"];

// Same codes the reference screen pre-fills as the default account mapping.
const DEFAULT_RECEIVABLE_CODE = "1-10100"; // Piutang Usaha
const DEFAULT_PAYABLE_CODE = "2-20100"; // Hutang Usaha

function mapRow(row: any, types: ContactType[], bankAccounts: any[]) {
  return {
    id: row.id,
    businessUnit: row.business_unit,
    types,
    name: row.name,
    salutation: row.salutation,
    firstName: row.first_name,
    middleName: row.middle_name,
    lastName: row.last_name,
    companyName: row.company_name,
    address: row.address,
    shippingAddress: row.shipping_address,
    email: row.email,
    mobilePhone: row.mobile_phone,
    phone: row.phone,
    fax: row.fax,
    citizenship: row.citizenship,
    npwp: row.npwp,
    idType: row.id_type,
    idNumber: row.id_number,
    nitku: row.nitku,
    paymentTerm: row.payment_term,
    receivableAccountId: row.receivable_account_id,
    payableAccountId: row.payable_account_id,
    notes: row.notes,
    isActive: !!row.is_active,
    createdAt: row.created_at,
    bankAccounts: bankAccounts.map((b) => ({
      id: b.id,
      bankName: b.bank_name,
      branch: b.branch,
      accountHolder: b.account_holder,
      accountNumber: b.account_number,
    })),
  };
}

async function getTypesByContactIds(ids: number[]): Promise<Map<number, ContactType[]>> {
  const map = new Map<number, ContactType[]>();
  if (!ids.length) return map;
  const [rows] = await pool.query("SELECT contact_id, type FROM contact_types WHERE contact_id IN (?)", [ids]);
  for (const row of rows as any[]) {
    const list = map.get(row.contact_id) ?? [];
    list.push(row.type);
    map.set(row.contact_id, list);
  }
  return map;
}

function parseTypes(input: unknown): ContactType[] {
  const list = Array.isArray(input) ? input : [input];
  const valid = list.filter((t): t is ContactType => CONTACT_TYPES.includes(t));
  return valid.length ? Array.from(new Set(valid)) : ["customer"];
}

interface BankAccountInput {
  bankName?: string | null;
  branch?: string | null;
  accountHolder?: string | null;
  accountNumber?: string | null;
}

function parseBankAccounts(input: unknown): BankAccountInput[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((b) => ({
      bankName: b?.bankName || null,
      branch: b?.branch || null,
      accountHolder: b?.accountHolder || null,
      accountNumber: b?.accountNumber || null,
    }))
    .filter((b) => b.bankName || b.branch || b.accountHolder || b.accountNumber);
}

async function replaceBankAccounts(conn: PoolConnection, contactId: number, bankAccounts: BankAccountInput[]) {
  await conn.query("DELETE FROM contact_bank_accounts WHERE contact_id = ?", [contactId]);
  for (const b of bankAccounts) {
    await conn.query(
      "INSERT INTO contact_bank_accounts (contact_id, bank_name, branch, account_holder, account_number) VALUES (?, ?, ?, ?, ?)",
      [contactId, b.bankName, b.branch, b.accountHolder, b.accountNumber]
    );
  }
}

export const contactsController = {
  async list(req: Request, res: Response) {
    const type = req.query.type as string | undefined;
    const search = (req.query.search as string) || "";
    const includeArchived = req.query.includeArchived === "true";

    const clauses: string[] = ["c.business_unit = ?"];
    const params: unknown[] = [req.businessUnit];
    if (!includeArchived) clauses.push("c.is_active = TRUE");
    if (type && CONTACT_TYPES.includes(type as ContactType)) {
      clauses.push("EXISTS (SELECT 1 FROM contact_types ct WHERE ct.contact_id = c.id AND ct.type = ?)");
      params.push(type);
    }
    if (search) {
      clauses.push("(c.name LIKE ? OR c.company_name LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }

    const [rows] = await pool.query(`SELECT c.* FROM contacts c WHERE ${clauses.join(" AND ")} ORDER BY c.name`, params);
    const contactRows = rows as any[];
    const typesByContact = await getTypesByContactIds(contactRows.map((r) => r.id));
    res.json(contactRows.map((row) => mapRow(row, typesByContact.get(row.id) ?? [], [])));
  },

  async get(req: Request, res: Response) {
    const [rows] = await pool.query("SELECT * FROM contacts WHERE id = ?", [req.params.id]);
    const row = (rows as any[])[0];
    if (!row || row.business_unit !== req.businessUnit) throw new ApiError(404, "Kontak tidak ditemukan");
    const [typeRows] = await pool.query("SELECT type FROM contact_types WHERE contact_id = ?", [row.id]);
    const [bankRows] = await pool.query("SELECT * FROM contact_bank_accounts WHERE contact_id = ?", [row.id]);
    res.json(mapRow(row, (typeRows as any[]).map((r) => r.type), bankRows as any[]));
  },

  async create(req: Request, res: Response) {
    const {
      types,
      name,
      salutation,
      firstName,
      middleName,
      lastName,
      companyName,
      address,
      shippingAddress,
      email,
      mobilePhone,
      phone,
      fax,
      citizenship,
      npwp,
      idType,
      idNumber,
      nitku,
      paymentTerm,
      receivableAccountId,
      payableAccountId,
      notes,
      bankAccounts,
    } = req.body;
    if (!name) throw new ApiError(400, "Nama tampilan wajib diisi");

    const resolvedReceivableId = receivableAccountId
      ? Number(receivableAccountId)
      : await getAccountIdByCode(DEFAULT_RECEIVABLE_CODE, req.businessUnit);
    const resolvedPayableId = payableAccountId
      ? Number(payableAccountId)
      : await getAccountIdByCode(DEFAULT_PAYABLE_CODE, req.businessUnit);

    const conn: PoolConnection = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [result] = await conn.query(
        `INSERT INTO contacts
           (business_unit, name, salutation, first_name, middle_name, last_name, company_name, address,
            shipping_address, email, mobile_phone, phone, fax, citizenship, npwp, id_type, id_number, nitku,
            payment_term, receivable_account_id, payable_account_id, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          req.businessUnit,
          name,
          salutation || null,
          firstName || null,
          middleName || null,
          lastName || null,
          companyName || null,
          address || null,
          shippingAddress || null,
          email || null,
          mobilePhone || null,
          phone || null,
          fax || null,
          citizenship === "wna" ? "wna" : "wni",
          npwp || null,
          idType || null,
          idNumber || null,
          nitku || null,
          paymentTerm || null,
          resolvedReceivableId,
          resolvedPayableId,
          notes || null,
        ]
      );
      const insertId = (result as any).insertId;

      for (const t of parseTypes(types)) {
        await conn.query("INSERT INTO contact_types (contact_id, type) VALUES (?, ?)", [insertId, t]);
      }
      await replaceBankAccounts(conn, insertId, parseBankAccounts(bankAccounts));

      await conn.commit();

      const [rows] = await pool.query("SELECT * FROM contacts WHERE id = ?", [insertId]);
      const [typeRows] = await pool.query("SELECT type FROM contact_types WHERE contact_id = ?", [insertId]);
      const [bankRows] = await pool.query("SELECT * FROM contact_bank_accounts WHERE contact_id = ?", [insertId]);
      res.status(201).json(mapRow((rows as any[])[0], (typeRows as any[]).map((r) => r.type), bankRows as any[]));
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },
};
