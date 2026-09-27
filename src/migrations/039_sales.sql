-- "Penjualan" (Sales) -- mirrors migrations/038_purchases.sql's pipeline but for the
-- revenue side: Penawaran -> Pesanan -> Faktur (the only stage that posts to the
-- ledger) -> Pengiriman. No "Permintaan" (that's an internal-only concept on the buy
-- side) and no "Tukar Faktur" (not asked for here) -- a separate table rather than
-- reusing purchase_documents with a direction flag, since the accounting is mirrored
-- (debit Akun Piutang / credit Income + PPN Keluaran, not credit Akun Hutang / debit
-- expense + PPN Masukan) and forcing one table to carry both would need a direction
-- column threaded through every query anyway.
CREATE TABLE sale_documents (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_unit ENUM('zarve', 'b2b') NOT NULL DEFAULT 'b2b',
  doc_type ENUM('quotation', 'order', 'invoice', 'shipment') NOT NULL,
  number VARCHAR(50) NOT NULL,
  status ENUM('draft', 'pending_approval', 'approved', 'rejected') NOT NULL DEFAULT 'draft',
  contact_id INT NULL REFERENCES contacts(id),
  document_date DATE NOT NULL,
  due_date DATE NULL,
  reference VARCHAR(191) NULL,
  memo TEXT NULL,
  subtotal DECIMAL(18, 2) NOT NULL DEFAULT 0,
  tax_total DECIMAL(18, 2) NOT NULL DEFAULT 0,
  total_amount DECIMAL(18, 2) NOT NULL DEFAULT 0,
  converted_from_id INT NULL REFERENCES sale_documents(id),
  submitted_by INT NULL REFERENCES users(id),
  approved_by INT NULL REFERENCES users(id),
  approved_at TIMESTAMP NULL,
  rejected_reason TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sale_documents_unit_number (business_unit, number)
);

CREATE TABLE sale_document_lines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  document_id INT NOT NULL REFERENCES sale_documents(id),
  account_id INT NULL REFERENCES accounts(id),
  description VARCHAR(255) NULL,
  qty DECIMAL(18, 4) NOT NULL DEFAULT 1,
  unit_price DECIMAL(18, 2) NOT NULL DEFAULT 0,
  tax_id INT NULL REFERENCES taxes(id),
  amount DECIMAL(18, 2) NOT NULL DEFAULT 0,
  tax_amount DECIMAL(18, 2) NOT NULL DEFAULT 0
);

-- Money received against an approved sales invoice -- mirrors purchase_payments.
CREATE TABLE sale_payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  document_id INT NOT NULL REFERENCES sale_documents(id),
  bank_account_id INT NOT NULL REFERENCES accounts(id),
  amount DECIMAL(18, 2) NOT NULL,
  payment_date DATE NOT NULL,
  memo VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE journal_entries MODIFY COLUMN source_type
  ENUM('invoice', 'payment', 'manual', 'vendor_bill', 'vendor_payment', 'expense',
       'purchase_invoice', 'purchase_payment', 'sale_invoice', 'sale_payment') NOT NULL;
