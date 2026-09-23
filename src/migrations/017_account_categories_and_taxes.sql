-- Makes the B2B "Daftar Akun" create form's Kategori Akun and Pajak dropdowns real:
-- Kategori Akun was a hardcoded list in the frontend (lib/accountCategory.ts); Pajak
-- was a dead, disabled placeholder. Both become manageable via a new B2B-only Settings
-- screen. Scoped to 'b2b' only -- Zarve's plain accounts page and its
-- WELL_KNOWN_ACCOUNTS convention are untouched.
CREATE TABLE account_categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_unit ENUM('zarve', 'b2b') NOT NULL DEFAULT 'b2b',
  value VARCHAR(50) NOT NULL,
  label VARCHAR(100) NOT NULL,
  type ENUM('asset', 'liability', 'equity', 'income', 'expense') NOT NULL,
  code_hint VARCHAR(20) NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_account_categories_unit_value (business_unit, value)
);

CREATE TABLE taxes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_unit ENUM('zarve', 'b2b') NOT NULL DEFAULT 'b2b',
  name VARCHAR(100) NOT NULL,
  rate DECIMAL(5, 2) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE accounts ADD COLUMN category_id INT NULL, ADD COLUMN tax_id INT NULL;
ALTER TABLE accounts ADD FOREIGN KEY (category_id) REFERENCES account_categories(id);
ALTER TABLE accounts ADD FOREIGN KEY (tax_id) REFERENCES taxes(id);

-- "Akses akun" (which users can access this account) -- 'all' (default) or 'some',
-- restricted to specific users via account_access_users. There is no "specific role"
-- option: this app has a single "admin" role for everyone, so per-role scoping isn't
-- meaningful here.
ALTER TABLE accounts ADD COLUMN access_mode ENUM('all', 'some') NOT NULL DEFAULT 'all';

CREATE TABLE account_access_users (
  account_id INT NOT NULL,
  user_id INT NOT NULL,
  PRIMARY KEY (account_id, user_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Starter categories: the same 14 that used to be hardcoded in
-- lib/accountCategory.ts, now editable/extendable via the Settings screen instead.
INSERT INTO account_categories (business_unit, value, label, type, code_hint) VALUES
('b2b', 'cash_bank', 'Cash & Bank', 'asset', '11'),
('b2b', 'ar', 'Accounts Receivable (A/R)', 'asset', '12'),
('b2b', 'inventory', 'Inventory', 'asset', '13'),
('b2b', 'other_current_asset', 'Other Current Assets', 'asset', '14'),
('b2b', 'fixed_asset', 'Fixed Assets', 'asset', '15'),
('b2b', 'ap', 'Accounts Payable (A/P)', 'liability', '21'),
('b2b', 'other_current_liability', 'Other Current Liability', 'liability', '23'),
('b2b', 'long_term_liability', 'Long Term Liability', 'liability', '25'),
('b2b', 'equity', 'Equity', 'equity', '31'),
('b2b', 'income', 'Income', 'income', '41'),
('b2b', 'other_income', 'Other Income', 'income', '49'),
('b2b', 'cogs', 'Cost of Goods Sold', 'expense', '51'),
('b2b', 'expense', 'Expense', 'expense', '52'),
('b2b', 'other_expense', 'Other Expense', 'expense', '59');

-- Backfill category_id on the 18 B2B seed accounts (014_business_unit.sql) using the
-- same code-prefix convention the categories above were derived from, so existing
-- accounts show a real category immediately instead of relying on the frontend's
-- prefix-guessing fallback.
UPDATE accounts a
JOIN account_categories c ON c.business_unit = 'b2b' AND c.value = (
  CASE
    WHEN a.type = 'asset' AND a.code LIKE '11%' THEN 'cash_bank'
    WHEN a.type = 'asset' AND a.code LIKE '12%' THEN 'ar'
    WHEN a.type = 'asset' AND a.code LIKE '13%' THEN 'inventory'
    WHEN a.type = 'asset' AND a.code LIKE '14%' THEN 'other_current_asset'
    WHEN a.type = 'asset' AND a.code LIKE '15%' THEN 'fixed_asset'
    WHEN a.type = 'liability' AND a.code LIKE '21%' THEN 'ap'
    WHEN a.type = 'liability' AND (a.code LIKE '23%' OR a.code LIKE '24%') THEN 'other_current_liability'
    WHEN a.type = 'liability' THEN 'long_term_liability'
    WHEN a.type = 'equity' THEN 'equity'
    WHEN a.type = 'income' AND a.code LIKE '49%' THEN 'other_income'
    WHEN a.type = 'income' THEN 'income'
    WHEN a.type = 'expense' AND a.code LIKE '51%' THEN 'cogs'
    WHEN a.type = 'expense' AND a.code LIKE '59%' THEN 'other_expense'
    WHEN a.type = 'expense' THEN 'expense'
  END
)
SET a.category_id = c.id
WHERE a.business_unit = 'b2b';
