-- Closes several gaps vs standard Odoo Accounting: vendor bills/payments (accounts
-- payable -- previously there was no way to record money owed to or paid to a
-- supplier), manual journal entries need no new table (journal_entries/journal_lines
-- already exist), tax fields on invoice lines (PPN, off by default), and an Opening
-- Balance Equity account for onboarding historical balances via a manual journal entry.

ALTER TABLE partners ADD COLUMN type ENUM('customer', 'vendor') NOT NULL DEFAULT 'customer';

ALTER TABLE journal_entries MODIFY COLUMN source_type ENUM('invoice', 'payment', 'manual', 'vendor_bill', 'vendor_payment') NOT NULL;

CREATE TABLE vendor_bills (
  id INT AUTO_INCREMENT PRIMARY KEY,
  number VARCHAR(50) NOT NULL UNIQUE,
  vendor_id INT NOT NULL,
  bill_date DATE NOT NULL,
  ref VARCHAR(100) NULL,
  total_amount DECIMAL(18, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (vendor_id) REFERENCES partners(id),
  INDEX idx_vendor_bills_date (bill_date)
);

CREATE TABLE vendor_bill_lines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  vendor_bill_id INT NOT NULL,
  description VARCHAR(255) NOT NULL,
  account_id INT NOT NULL,
  vehicle_id INT NULL,
  amount DECIMAL(18, 2) NOT NULL,
  FOREIGN KEY (vendor_bill_id) REFERENCES vendor_bills(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (vehicle_id) REFERENCES vehicles(id)
);

CREATE TABLE vendor_payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  vendor_id INT NOT NULL,
  vendor_bill_id INT NULL,
  bank_account_id INT NOT NULL,
  amount DECIMAL(18, 2) NOT NULL,
  date DATE NOT NULL,
  method VARCHAR(50) NULL,
  memo VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (vendor_id) REFERENCES partners(id),
  FOREIGN KEY (vendor_bill_id) REFERENCES vendor_bills(id),
  FOREIGN KEY (bank_account_id) REFERENCES accounts(id)
);

ALTER TABLE invoice_lines
  ADD COLUMN tax_rate DECIMAL(6, 4) NOT NULL DEFAULT 0,
  ADD COLUMN tax_amount DECIMAL(18, 2) NOT NULL DEFAULT 0;

ALTER TABLE app_settings
  ADD COLUMN ppn_enabled TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN ppn_rate DECIMAL(6, 4) NOT NULL DEFAULT 0.11;

INSERT INTO accounts (code, name, type) VALUES
  ('2303', 'PPN Keluaran', 'liability'),
  ('1301', 'PPN Masukan', 'asset'),
  ('3103', 'Saldo Awal (Opening Balance Equity)', 'equity');
