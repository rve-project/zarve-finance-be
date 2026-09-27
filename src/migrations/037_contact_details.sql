-- Expands "Kontak" to match the reference create-contact screen: full name split,
-- identity/tax fields, separate billing/shipping address, repeatable bank accounts,
-- and per-contact AR/AP account mapping + payment terms (used when this contact is
-- picked as an expense's "Bayar Nanti" payee -- see expenses.controller.ts).
ALTER TABLE contacts
  ADD COLUMN salutation VARCHAR(20) NULL AFTER name,
  ADD COLUMN first_name VARCHAR(100) NULL AFTER salutation,
  ADD COLUMN middle_name VARCHAR(100) NULL AFTER first_name,
  ADD COLUMN last_name VARCHAR(100) NULL AFTER middle_name,
  ADD COLUMN id_type VARCHAR(30) NULL AFTER npwp,
  ADD COLUMN id_number VARCHAR(50) NULL AFTER id_type,
  ADD COLUMN fax VARCHAR(50) NULL AFTER phone,
  ADD COLUMN shipping_address TEXT NULL AFTER address,
  ADD COLUMN citizenship ENUM('wni', 'wna') NOT NULL DEFAULT 'wni' AFTER id_number,
  ADD COLUMN nitku VARCHAR(20) NULL AFTER citizenship,
  ADD COLUMN payment_term VARCHAR(50) NULL,
  ADD COLUMN receivable_account_id INT NULL REFERENCES accounts(id),
  ADD COLUMN payable_account_id INT NULL REFERENCES accounts(id);

-- Multi-select "Tipe kontak" (Pelanggan/Supplier/Karyawan/Lainnya can all apply at
-- once) -- replaces the old single `type` enum, which only ever allowed one.
CREATE TABLE contact_types (
  contact_id INT NOT NULL REFERENCES contacts(id),
  type ENUM('customer', 'vendor', 'employee', 'other') NOT NULL,
  PRIMARY KEY (contact_id, type)
);
INSERT INTO contact_types (contact_id, type) SELECT id, type FROM contacts;
ALTER TABLE contacts DROP COLUMN type;

CREATE TABLE contact_bank_accounts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  contact_id INT NOT NULL REFERENCES contacts(id),
  bank_name VARCHAR(100) NULL,
  branch VARCHAR(100) NULL,
  account_holder VARCHAR(191) NULL,
  account_number VARCHAR(50) NULL
);
