-- Client asked for the B2B "Kategori Akun" dropdown to show a fixed Indonesian-named
-- list instead of the free-editable English one (management UI removed from
-- Settings). Asset categories (Kas & Bank, Piutang, Persediaan, dst) are deliberately
-- left out of that list per the client's own call -- soft-hidden (is_active = 0)
-- rather than deleted, since real accounts already reference them and hard-deleting
-- would violate the accounts.category_id foreign key.
UPDATE account_categories SET label = 'Akun Hutang' WHERE business_unit = 'b2b' AND value = 'ap';
UPDATE account_categories SET label = 'Liabilitas Jangka Pendek' WHERE business_unit = 'b2b' AND value = 'other_current_liability';
UPDATE account_categories SET label = 'Liabilitas Jangka Panjang' WHERE business_unit = 'b2b' AND value = 'long_term_liability';
UPDATE account_categories SET label = 'Ekuitas' WHERE business_unit = 'b2b' AND value = 'equity';
UPDATE account_categories SET label = 'Pendapatan' WHERE business_unit = 'b2b' AND value = 'income';
UPDATE account_categories SET label = 'Pendapatan Lainnya' WHERE business_unit = 'b2b' AND value = 'other_income';
UPDATE account_categories SET label = 'Harga Pokok Penjualan' WHERE business_unit = 'b2b' AND value = 'cogs';
UPDATE account_categories SET label = 'Beban' WHERE business_unit = 'b2b' AND value = 'expense';
UPDATE account_categories SET label = 'Beban Lainnya' WHERE business_unit = 'b2b' AND value = 'other_expense';

INSERT INTO account_categories (business_unit, value, label, type, code_hint)
VALUES ('b2b', 'credit_card', 'Kartu Kredit', 'liability', '22');

UPDATE account_categories
SET is_active = 0
WHERE business_unit = 'b2b' AND value IN ('cash_bank', 'ar', 'inventory', 'other_current_asset', 'fixed_asset');
