CREATE TABLE accounts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(20) NOT NULL UNIQUE,
  name VARCHAR(191) NOT NULL,
  type ENUM('asset', 'liability', 'equity', 'income', 'expense') NOT NULL,
  parent_id INT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  FOREIGN KEY (parent_id) REFERENCES accounts(id)
);

CREATE TABLE partners (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(191) NOT NULL,
  ktp_number VARCHAR(20) NULL,
  phone VARCHAR(50) NULL,
  email VARCHAR(191) NULL,
  notes TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_partner_ktp_name (ktp_number, name),
  INDEX idx_partner_name (name)
);

CREATE TABLE vehicles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  plate_number VARCHAR(20) NOT NULL UNIQUE,
  name VARCHAR(191) NOT NULL,
  category ENUM('ev', 'fuel') NOT NULL DEFAULT 'fuel',
  branch VARCHAR(100) NULL,
  income_account_id INT NULL,
  analytic_tag VARCHAR(100) NULL,
  FOREIGN KEY (income_account_id) REFERENCES accounts(id)
);

CREATE TABLE journal_entries (
  id INT AUTO_INCREMENT PRIMARY KEY,
  date DATE NOT NULL,
  ref VARCHAR(100) NULL,
  narration TEXT NULL,
  source_type ENUM('invoice', 'payment', 'manual') NOT NULL,
  source_id INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_journal_entries_date (date),
  INDEX idx_journal_entries_source (source_type, source_id)
);

CREATE TABLE journal_lines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  journal_entry_id INT NOT NULL,
  account_id INT NOT NULL,
  partner_id INT NULL,
  debit DECIMAL(18, 2) NOT NULL DEFAULT 0,
  credit DECIMAL(18, 2) NOT NULL DEFAULT 0,
  analytic_tag VARCHAR(100) NULL,
  FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (partner_id) REFERENCES partners(id),
  INDEX idx_journal_lines_account (account_id),
  INDEX idx_journal_lines_partner (partner_id)
);

CREATE TABLE invoices (
  id INT AUTO_INCREMENT PRIMARY KEY,
  number VARCHAR(50) NOT NULL UNIQUE,
  partner_id INT NOT NULL,
  vehicle_id INT NULL,
  invoice_date DATE NOT NULL,
  state ENUM('draft', 'posted') NOT NULL DEFAULT 'draft',
  ref VARCHAR(100) NULL,
  total_amount DECIMAL(18, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (partner_id) REFERENCES partners(id),
  FOREIGN KEY (vehicle_id) REFERENCES vehicles(id),
  UNIQUE KEY uq_invoice_idempotency (partner_id, vehicle_id, invoice_date),
  INDEX idx_invoices_date (invoice_date)
);

CREATE TABLE invoice_lines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  invoice_id INT NOT NULL,
  description VARCHAR(255) NOT NULL,
  category ENUM('DAILY', 'THR', 'REFF', 'ADMIN_FEE', 'OTHER') NOT NULL DEFAULT 'DAILY',
  account_id INT NOT NULL,
  amount DECIMAL(18, 2) NOT NULL,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  partner_id INT NOT NULL,
  invoice_id INT NULL,
  amount DECIMAL(18, 2) NOT NULL,
  date DATE NOT NULL,
  method VARCHAR(50) NULL,
  memo VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (partner_id) REFERENCES partners(id),
  FOREIGN KEY (invoice_id) REFERENCES invoices(id),
  INDEX idx_payments_date (date)
);

CREATE TABLE import_batches (
  id INT AUTO_INCREMENT PRIMARY KEY,
  file_name VARCHAR(255) NOT NULL,
  period_info VARCHAR(100) NULL,
  total_rows INT NOT NULL DEFAULT 0,
  total_invoices INT NOT NULL DEFAULT 0,
  total_payments INT NOT NULL DEFAULT 0,
  state ENUM('done', 'error') NOT NULL DEFAULT 'done',
  error_log TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(191) NOT NULL UNIQUE,
  name VARCHAR(191) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('admin') NOT NULL DEFAULT 'admin',
  aktif BOOLEAN NOT NULL DEFAULT TRUE
);
