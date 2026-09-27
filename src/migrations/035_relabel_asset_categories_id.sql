-- Finishes translating the "Kategori Akun" dropdown to Indonesian -- 033 only did the
-- non-asset half; these 5 asset categories (reactivated in 034 for the full COA import)
-- and the "Depreciation & Amortization" category 034 added were still in English.
UPDATE account_categories SET label = 'Kas & Bank' WHERE business_unit = 'b2b' AND value = 'cash_bank';
UPDATE account_categories SET label = 'Akun Piutang' WHERE business_unit = 'b2b' AND value = 'ar';
UPDATE account_categories SET label = 'Persediaan' WHERE business_unit = 'b2b' AND value = 'inventory';
UPDATE account_categories SET label = 'Aset Lancar Lainnya' WHERE business_unit = 'b2b' AND value = 'other_current_asset';
UPDATE account_categories SET label = 'Aset Tetap' WHERE business_unit = 'b2b' AND value = 'fixed_asset';
UPDATE account_categories SET label = 'Depresiasi & Amortisasi' WHERE business_unit = 'b2b' AND value = 'dep_amort';
