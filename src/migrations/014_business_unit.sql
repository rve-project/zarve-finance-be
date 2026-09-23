-- The client is starting a second, completely separate business ("B2B") tracked in
-- this same app, alongside the existing car-rental business ("Zarve"). Both need their
-- own chart of accounts and bookkeeping. `business_unit` scopes accounts and journal
-- entries to one or the other; everything else (invoices, partners, vehicles, vendor
-- bills, reconciliation, geofence, revenue recap, sync/import) stays Zarve-only and is
-- untouched by this migration.
ALTER TABLE accounts ADD COLUMN business_unit ENUM('zarve', 'b2b') NOT NULL DEFAULT 'zarve';
ALTER TABLE journal_entries ADD COLUMN business_unit ENUM('zarve', 'b2b') NOT NULL DEFAULT 'zarve';

-- accounts.code was globally unique; make it unique per business unit instead so B2B
-- can reuse Zarve's numbering scheme (e.g. both can have a '1101' cash account).
ALTER TABLE accounts DROP INDEX code;
ALTER TABLE accounts ADD UNIQUE KEY uq_accounts_unit_code (business_unit, code);

ALTER TABLE journal_entries ADD INDEX idx_journal_entries_unit_date (business_unit, date);

-- B2B starter chart of accounts -- a generic, non-rental set covering all 5 account
-- types, reusing the same '11xx' cash/bank code prefix convention as Zarve's chart so
-- the cash-flow report's `code.startsWith('11')` filter works unmodified for B2B too.
-- Starting set only -- more accounts get added later via the Chart of Accounts screen.
INSERT INTO accounts (code, name, type, business_unit) VALUES
-- Assets
('1101', 'Kas', 'asset', 'b2b'),
('1111', 'Bank', 'asset', 'b2b'),
('1201', 'Piutang Usaha', 'asset', 'b2b'),
('1401', 'Biaya Dibayar Dimuka', 'asset', 'b2b'),
('1501', 'Aset Tetap', 'asset', 'b2b'),
('1502', 'Akumulasi Penyusutan', 'asset', 'b2b'),
-- Liabilities
('2101', 'Utang Usaha', 'liability', 'b2b'),
('2301', 'Utang Pajak', 'liability', 'b2b'),
('2401', 'Pendapatan Diterima Dimuka', 'liability', 'b2b'),
-- Equity
('3101', 'Modal Disetor', 'equity', 'b2b'),
('3102', 'Laba Ditahan', 'equity', 'b2b'),
('3103', 'Saldo Awal (Opening Balance Equity)', 'equity', 'b2b'),
-- Income
('4101', 'Pendapatan Usaha', 'income', 'b2b'),
('4901', 'Pendapatan Lain-lain', 'income', 'b2b'),
-- Expenses
('5101', 'Beban Gaji dan Upah', 'expense', 'b2b'),
('5201', 'Beban Operasional', 'expense', 'b2b'),
('5301', 'Beban Sewa Kantor', 'expense', 'b2b'),
('5901', 'Beban Lain-lain', 'expense', 'b2b');
