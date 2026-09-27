-- "Pembelian" (Purchases) -- the full procurement pipeline from the reference screen:
-- Permintaan (request) -> Penawaran (quotation) -> Pemesanan (order) -> Faktur
-- (invoice, the only stage that posts to the ledger) -> Tukar Faktur (exchange/credit
-- note) and Pengiriman (goods receipt) as side documents against an invoice/order. One
-- shared table for all six document types (doc_type) instead of six near-identical
-- tables -- they differ only in which fields matter and whether they post a journal
-- entry, not in shape. B2B-only, like the rest of this session's B2B build-out.
CREATE TABLE purchase_documents (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_unit ENUM('zarve', 'b2b') NOT NULL DEFAULT 'b2b',
  doc_type ENUM('request', 'quotation', 'order', 'invoice', 'exchange', 'shipment') NOT NULL,
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
  converted_from_id INT NULL REFERENCES purchase_documents(id),
  submitted_by INT NULL REFERENCES users(id),
  approved_by INT NULL REFERENCES users(id),
  approved_at TIMESTAMP NULL,
  rejected_reason TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_purchase_documents_unit_number (business_unit, number)
);

CREATE TABLE purchase_document_lines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  document_id INT NOT NULL REFERENCES purchase_documents(id),
  account_id INT NULL REFERENCES accounts(id),
  description VARCHAR(255) NULL,
  qty DECIMAL(18, 4) NOT NULL DEFAULT 1,
  unit_price DECIMAL(18, 2) NOT NULL DEFAULT 0,
  tax_id INT NULL REFERENCES taxes(id),
  amount DECIMAL(18, 2) NOT NULL DEFAULT 0,
  tax_amount DECIMAL(18, 2) NOT NULL DEFAULT 0
);

-- Payments recorded against an approved invoice -- separate from expenses.controller.ts's
-- payments (which are one-step, paid-at-creation-time); a purchase invoice is always
-- unpaid at first and gets paid off over one or more later transactions, same shape as
-- Zarve's vendor_bills + vendor_payments two-step pattern.
CREATE TABLE purchase_payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  document_id INT NOT NULL REFERENCES purchase_documents(id),
  bank_account_id INT NOT NULL REFERENCES accounts(id),
  amount DECIMAL(18, 2) NOT NULL,
  payment_date DATE NOT NULL,
  memo VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE journal_entries MODIFY COLUMN source_type
  ENUM('invoice', 'payment', 'manual', 'vendor_bill', 'vendor_payment', 'expense', 'purchase_invoice', 'purchase_payment') NOT NULL;
