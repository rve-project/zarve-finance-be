import { Request, Response } from "express";
import { pool } from "../db";
import { ApiError } from "../middlewares/errorHandler";

function mapRow(row: any) {
  return {
    companyName: row?.company_name ?? "",
    address: row?.address ?? "",
    phone: row?.phone ?? "",
    email: row?.email ?? "",
    logoUrl: row?.logo_url ?? null,
    bankName: row?.bank_name ?? "",
    bankAccountNumber: row?.bank_account_number ?? "",
    bankAccountHolder: row?.bank_account_holder ?? "",
    showLogo: row ? !!row.show_logo : true,
    showBankInfo: row ? !!row.show_bank_info : true,
    showPaymentTerm: row ? !!row.show_payment_term : true,
    showNotes: row ? !!row.show_notes : true,
    footerNote: row?.footer_note ?? "",
  };
}

/**
 * "Template Dokumen" -- company letterhead (name/address/logo/bank account) plus which
 * sections the shared print template (components/print/DocumentPrintTemplate.tsx on the
 * frontend) shows on a printed Faktur Penjualan/Pembelian. One row per business unit; GET
 * returns sensible defaults (everything shown, blank company info) when the row doesn't
 * exist yet rather than 404, since every business unit starts without one.
 */
export const documentSettingsController = {
  async get(req: Request, res: Response) {
    const [rows] = await pool.query("SELECT * FROM document_settings WHERE business_unit = ?", [req.businessUnit]);
    res.json(mapRow((rows as any[])[0]));
  },

  async update(req: Request, res: Response) {
    const {
      companyName,
      address,
      phone,
      email,
      logoUrl,
      bankName,
      bankAccountNumber,
      bankAccountHolder,
      showLogo,
      showBankInfo,
      showPaymentTerm,
      showNotes,
      footerNote,
    } = req.body;

    await pool.query(
      `INSERT INTO document_settings
         (business_unit, company_name, address, phone, email, logo_url, bank_name, bank_account_number,
          bank_account_holder, show_logo, show_bank_info, show_payment_term, show_notes, footer_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         company_name = VALUES(company_name), address = VALUES(address), phone = VALUES(phone), email = VALUES(email),
         logo_url = VALUES(logo_url), bank_name = VALUES(bank_name), bank_account_number = VALUES(bank_account_number),
         bank_account_holder = VALUES(bank_account_holder), show_logo = VALUES(show_logo),
         show_bank_info = VALUES(show_bank_info), show_payment_term = VALUES(show_payment_term),
         show_notes = VALUES(show_notes), footer_note = VALUES(footer_note)`,
      [
        req.businessUnit,
        companyName || null,
        address || null,
        phone || null,
        email || null,
        logoUrl || null,
        bankName || null,
        bankAccountNumber || null,
        bankAccountHolder || null,
        showLogo !== false,
        showBankInfo !== false,
        showPaymentTerm !== false,
        showNotes !== false,
        footerNote || null,
      ]
    );

    const [rows] = await pool.query("SELECT * FROM document_settings WHERE business_unit = ?", [req.businessUnit]);
    res.json(mapRow((rows as any[])[0]));
  },

  /** Real upload -- saved to disk, mirrors products.controller.ts's uploadImage. */
  async uploadLogo(req: Request, res: Response) {
    if (!req.file) throw new ApiError(400, "File logo wajib diunggah");
    res.status(201).json({ url: `/uploads/document-settings/${req.file.filename}` });
  },
};
