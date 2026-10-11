-- Tracks which (asset, calendar month) depreciation periods have actually had a journal
-- entry posted for them -- computeDepreciation()/periodDepreciation() in
-- utils/depreciation.ts only ever *compute* a theoretical schedule on the fly, they
-- never recorded whether a period was actually posted to the books. The "Jalankan
-- Penyusutan" button (POST /fixed-assets/run-depreciation) reads this table to find
-- which periods are still due and to avoid posting the same period twice.
CREATE TABLE fixed_asset_depreciation_postings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  fixed_asset_id INT NOT NULL,
  period CHAR(7) NOT NULL, -- 'YYYY-MM'
  amount DECIMAL(14, 2) NOT NULL,
  journal_entry_id INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (fixed_asset_id) REFERENCES fixed_assets(id),
  FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id),
  UNIQUE KEY uq_fixed_asset_depreciation_postings (fixed_asset_id, period)
);
