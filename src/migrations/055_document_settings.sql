-- "Template Dokumen" -- company letterhead info (name, address, logo, bank account) plus
-- which sections a printed document shows, so Faktur Penjualan/Pembelian (and anything
-- else built on the shared print template) aren't stuck with the bare, unbranded print
-- that's literally just the on-screen detail view today. One row per business unit,
-- business_unit itself as the primary key since this is a singleton per unit (no list,
-- no id) -- GET returns sensible defaults when the row doesn't exist yet rather than 404.
CREATE TABLE document_settings (
  business_unit ENUM('zarve', 'b2b') NOT NULL PRIMARY KEY,
  company_name VARCHAR(255) NULL,
  address TEXT NULL,
  phone VARCHAR(50) NULL,
  email VARCHAR(255) NULL,
  logo_url VARCHAR(500) NULL,
  bank_name VARCHAR(100) NULL,
  bank_account_number VARCHAR(100) NULL,
  bank_account_holder VARCHAR(255) NULL,
  show_logo BOOLEAN NOT NULL DEFAULT TRUE,
  show_bank_info BOOLEAN NOT NULL DEFAULT TRUE,
  show_payment_term BOOLEAN NOT NULL DEFAULT TRUE,
  show_notes BOOLEAN NOT NULL DEFAULT TRUE,
  footer_note TEXT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
