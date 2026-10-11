-- Follow-up to D'Consulting gap #3 (migration 048): "Jenis Aset" was a hardcoded
-- 2-value ENUM ('general'/'vehicle') with no way to add more categories (electronics,
-- machinery, furniture, etc). Mirrors payment_terms (migration 054_payment_terms.sql):
-- a plain master-data table, referenced by NAME (not FK id) from fixed_assets.asset_type
-- so existing/historical assets keep their label even if the type row is later renamed
-- or deactivated.
CREATE TABLE fixed_asset_types (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_unit ENUM('zarve', 'b2b') NOT NULL DEFAULT 'b2b',
  name VARCHAR(100) NOT NULL,
  requires_plate_number BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO fixed_asset_types (business_unit, name, requires_plate_number) VALUES
  ('b2b', 'Umum', FALSE),
  ('b2b', 'Kendaraan Operasional', TRUE);

-- fixed_assets.asset_type switches from the old 'general'/'vehicle' ENUM to a free-text
-- name referencing fixed_asset_types.name (same convention as payment_term). Existing
-- rows are relabeled to match the newly seeded names.
ALTER TABLE fixed_assets MODIFY COLUMN asset_type VARCHAR(100) NOT NULL DEFAULT 'Umum';
UPDATE fixed_assets SET asset_type = 'Umum' WHERE asset_type = 'general';
UPDATE fixed_assets SET asset_type = 'Kendaraan Operasional' WHERE asset_type = 'vehicle';
