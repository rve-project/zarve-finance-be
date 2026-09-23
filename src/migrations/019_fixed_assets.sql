-- Fixed Asset register for B2B: buying an asset posts a real journal entry (debit the
-- chosen Fixed Asset account, credit whatever paid for it), and each asset optionally
-- carries straight-line depreciation parameters used to compute book value and a
-- monthly depreciation schedule (displayed only -- posting depreciation stays a manual
-- Jurnal Manual entry for now, not auto-posted). Disposing an asset posts its own
-- journal entry that removes the asset's cost and accumulated depreciation and books
-- any gain/loss on sale.
CREATE TABLE fixed_assets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_unit ENUM('zarve', 'b2b') NOT NULL DEFAULT 'b2b',
  asset_number VARCHAR(50) NOT NULL,
  name VARCHAR(191) NOT NULL,
  description TEXT NULL,
  category_account_id INT NOT NULL,
  acquisition_date DATE NOT NULL,
  acquisition_cost DECIMAL(14, 2) NOT NULL,
  -- NULL when the asset was activated from an already-posted journal line
  -- (sourceJournalLineId) instead of this screen posting its own purchase entry.
  credit_account_id INT NULL,
  is_non_depreciating BOOLEAN NOT NULL DEFAULT FALSE,
  depreciation_method ENUM('straight_line') NULL,
  useful_life_years DECIMAL(6, 2) NULL,
  depreciation_expense_account_id INT NULL,
  accumulated_depreciation_account_id INT NULL,
  opening_accumulated_depreciation DECIMAL(14, 2) NOT NULL DEFAULT 0,
  opening_accumulated_depreciation_date DATE NULL,
  status ENUM('active', 'disposed') NOT NULL DEFAULT 'active',
  disposal_date DATE NULL,
  disposal_amount DECIMAL(14, 2) NULL,
  disposal_journal_entry_id INT NULL,
  purchase_journal_entry_id INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_fixed_assets_unit_number (business_unit, asset_number),
  FOREIGN KEY (category_account_id) REFERENCES accounts(id),
  FOREIGN KEY (credit_account_id) REFERENCES accounts(id),
  FOREIGN KEY (depreciation_expense_account_id) REFERENCES accounts(id),
  FOREIGN KEY (accumulated_depreciation_account_id) REFERENCES accounts(id),
  FOREIGN KEY (disposal_journal_entry_id) REFERENCES journal_entries(id),
  FOREIGN KEY (purchase_journal_entry_id) REFERENCES journal_entries(id)
);
