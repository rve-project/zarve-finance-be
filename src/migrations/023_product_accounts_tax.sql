-- Matches Mekari's "Tambah produk baru" form: a product can independently be
-- something you buy ("Saya beli produk ini"), sell ("Saya jual produk ini"), or both
-- -- each side links to its own account (for future auto-posting when a real
-- purchase/sale transaction references this product) and its own tax code.
ALTER TABLE products
  ADD COLUMN barcode VARCHAR(100) NULL,
  ADD COLUMN description TEXT NULL,
  ADD COLUMN track_purchase BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN track_sale BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN purchase_account_id INT NULL,
  ADD COLUMN sale_account_id INT NULL,
  ADD COLUMN purchase_tax_id INT NULL,
  ADD COLUMN sale_tax_id INT NULL;

ALTER TABLE products
  ADD FOREIGN KEY (purchase_account_id) REFERENCES accounts(id),
  ADD FOREIGN KEY (sale_account_id) REFERENCES accounts(id),
  ADD FOREIGN KEY (purchase_tax_id) REFERENCES taxes(id),
  ADD FOREIGN KEY (sale_tax_id) REFERENCES taxes(id);
