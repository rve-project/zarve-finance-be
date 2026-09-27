-- "Pengeluaran" (Expenses) -- a one-step direct/paid-later expense entry (Mekari
-- Jurnal's "Buat Biaya"), distinct from vendor_bills: a vendor bill is always unpaid
-- until a separate vendorPayments entry settles it, while an expense here is usually
-- paid immediately from a chosen Kas & Bank account in the very same transaction (or,
-- if "Bayar Nanti" is checked, posted to Akun Hutang instead, same as a bill). B2B-only
-- for now -- Zarve has no equivalent screen and keeps using vendor_bills exclusively.
CREATE TABLE expenses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_unit ENUM('zarve', 'b2b') NOT NULL DEFAULT 'b2b',
  number VARCHAR(50) NOT NULL,
  contact_id INT NULL REFERENCES contacts(id),
  expense_date DATE NOT NULL,
  payment_method VARCHAR(50) NULL,
  bank_account_id INT NULL REFERENCES accounts(id),
  pay_later BOOLEAN NOT NULL DEFAULT FALSE,
  billing_address TEXT NULL,
  tag VARCHAR(191) NULL,
  memo TEXT NULL,
  discount_amount DECIMAL(18, 2) NOT NULL DEFAULT 0,
  total_amount DECIMAL(18, 2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_expenses_unit_number (business_unit, number)
);

CREATE TABLE expense_lines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  expense_id INT NOT NULL REFERENCES expenses(id),
  account_id INT NOT NULL REFERENCES accounts(id),
  description VARCHAR(255) NULL,
  tax_id INT NULL REFERENCES taxes(id),
  amount DECIMAL(18, 2) NOT NULL,
  tax_amount DECIMAL(18, 2) NOT NULL DEFAULT 0
);

ALTER TABLE journal_entries MODIFY COLUMN source_type
  ENUM('invoice', 'payment', 'manual', 'vendor_bill', 'vendor_payment', 'expense') NOT NULL;
