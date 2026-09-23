-- "Tipe Produk" (Single/Bundle) from Mekari's product form -- hardcoded (not
-- Settings-managed, there are only ever these two values), separate from the existing
-- Barang/Jasa `type` column. Also adds a real "Akun persediaan barang default" account
-- for the inventory-tracking section shown when Tipe Produk = Single ("Pelacakan
-- Persediaan": Lacak / Tidak dilacak) in the frontend.
ALTER TABLE products
  ADD COLUMN product_type ENUM('single', 'bundle') NOT NULL DEFAULT 'single',
  ADD COLUMN inventory_account_id INT NULL,
  ADD FOREIGN KEY (inventory_account_id) REFERENCES accounts(id);
