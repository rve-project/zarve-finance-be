import { Request, Response } from "express";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";
import { ContactType } from "../models/types";

/**
 * "Kontak" -- Pelanggan/Supplier/Karyawan/Lainnya, matching Mekari's Kontak screen. A
 * separate table from `partners` (see migrations/032_contacts.sql). No AR/AP invoicing
 * exists yet for B2B, so "Saldo" and the receivable/payable stat cards are always 0 --
 * shown honestly as 0 rather than faked, ready to wire up once B2B invoicing exists.
 */

const CONTACT_TYPES: ContactType[] = ["customer", "vendor", "employee", "other"];

function mapRow(row: any) {
  return {
    id: row.id,
    businessUnit: row.business_unit,
    type: row.type,
    name: row.name,
    companyName: row.company_name,
    address: row.address,
    email: row.email,
    mobilePhone: row.mobile_phone,
    phone: row.phone,
    npwp: row.npwp,
    notes: row.notes,
    isActive: !!row.is_active,
    createdAt: row.created_at,
  };
}

export const contactsController = {
  async list(req: Request, res: Response) {
    const type = req.query.type as string | undefined;
    const search = (req.query.search as string) || "";
    const includeArchived = req.query.includeArchived === "true";

    const clauses: string[] = ["business_unit = ?"];
    const params: unknown[] = [req.businessUnit];
    if (!includeArchived) clauses.push("is_active = TRUE");
    if (type && CONTACT_TYPES.includes(type as ContactType)) {
      clauses.push("type = ?");
      params.push(type);
    }
    if (search) {
      clauses.push("(name LIKE ? OR company_name LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }

    const [rows] = await pool.query(`SELECT * FROM contacts WHERE ${clauses.join(" AND ")} ORDER BY name`, params);
    res.json((rows as any[]).map(mapRow));
  },

  async create(req: Request, res: Response) {
    const { type, name, companyName, address, email, mobilePhone, phone, npwp, notes } = req.body;
    if (!name) throw new ApiError(400, "Nama panggilan wajib diisi");
    const resolvedType: ContactType = CONTACT_TYPES.includes(type) ? type : "customer";

    const [result] = await pool.query(
      `INSERT INTO contacts (business_unit, type, name, company_name, address, email, mobile_phone, phone, npwp, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.businessUnit, resolvedType, name, companyName || null, address || null, email || null, mobilePhone || null, phone || null, npwp || null, notes || null]
    );
    const insertId = (result as any).insertId;
    const [rows] = await pool.query("SELECT * FROM contacts WHERE id = ?", [insertId]);
    res.status(201).json(mapRow((rows as any[])[0]));
  },
};
