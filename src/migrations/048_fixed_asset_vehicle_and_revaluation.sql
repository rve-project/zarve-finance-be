-- D'Consulting audit gap #3: fixed_assets so far is fully generic -- there's no way to
-- tell "this is an internal operational vehicle" (RVE's own car, outside the rental
-- fleet in the Zarve-only `vehicles` table) apart from any other fixed asset (a
-- computer, office furniture, etc). Adds an optional vehicle sub-type + plate number,
-- entirely within fixed_assets -- the Zarve `vehicles` table/findOrCreateVehicle is not
-- touched at all.
ALTER TABLE fixed_assets
  ADD COLUMN asset_type ENUM('general', 'vehicle') NOT NULL DEFAULT 'general',
  ADD COLUMN plate_number VARCHAR(20) NULL;

-- D'Consulting audit gap #5: there was no way to change a fixed asset's value after
-- acquisition (revaluation / impairment). Book value is always computed on the fly from
-- acquisition_cost + opening_accumulated_depreciation (see utils/depreciation.ts) -- a
-- revaluation "rebases" those same inputs (new acquisition_cost, new acquisition_date,
-- opening_accumulated_depreciation reset to 0) so computeDepreciation keeps working
-- unchanged, and this table keeps the history of each rebase for audit purposes.
CREATE TABLE fixed_asset_revaluations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  fixed_asset_id INT NOT NULL,
  revaluation_date DATE NOT NULL,
  previous_acquisition_cost DECIMAL(14, 2) NOT NULL,
  previous_book_value DECIMAL(14, 2) NOT NULL,
  new_value DECIMAL(14, 2) NOT NULL,
  adjustment_amount DECIMAL(14, 2) NOT NULL,
  adjustment_account_id INT NOT NULL,
  journal_entry_id INT NOT NULL,
  notes TEXT NULL,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (fixed_asset_id) REFERENCES fixed_assets(id),
  FOREIGN KEY (adjustment_account_id) REFERENCES accounts(id),
  FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id),
  FOREIGN KEY (created_by) REFERENCES users(id),
  INDEX idx_fixed_asset_revaluations_asset (fixed_asset_id)
);
