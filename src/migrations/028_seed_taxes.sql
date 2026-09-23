-- "Pajak" was built as a real Settings-managed CRUD (b2bSettings.tabTaxes) but never
-- seeded with a starting value, so every tax dropdown (product Pajak beli/jual, etc.)
-- showed "Tidak ada opsi" until someone manually added one via Pengaturan. Seed the
-- standard Indonesian VAT rate as a starter -- editable/removable like any other tax
-- via the Settings screen.
INSERT INTO taxes (business_unit, name, rate) VALUES
('b2b', 'PPN 11%', 11.00);
