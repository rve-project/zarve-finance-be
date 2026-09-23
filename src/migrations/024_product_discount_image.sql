-- Matches the rest of Mekari's "Tambah produk baru" form: an optional discount
-- account for the sale side ("Butuh akun diskon? Aktifkan sekarang"), and a product
-- image (real upload + storage, served from /uploads -- see products.controller.ts's
-- uploadImage and app.ts's static file serving).
ALTER TABLE products
  ADD COLUMN discount_account_id INT NULL,
  ADD COLUMN image_url VARCHAR(500) NULL,
  ADD FOREIGN KEY (discount_account_id) REFERENCES accounts(id);
