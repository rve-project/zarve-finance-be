-- Mirrors migrations/040_purchase_products.sql/041_purchase_billing_address.sql for the
-- sales side -- brings "Buat Faktur Penjualan" (and Pesanan/Penawaran) up to the same
-- Produk-based line model + extra header fields as their Purchase counterparts, per the
-- reference screens.
ALTER TABLE sale_documents
  ADD COLUMN email VARCHAR(191) NULL,
  ADD COLUMN billing_address TEXT NULL,
  ADD COLUMN customer_ref VARCHAR(191) NULL,
  ADD COLUMN tag VARCHAR(100) NULL,
  ADD COLUMN customer_note TEXT NULL,
  ADD COLUMN payment_term VARCHAR(100) NULL,
  ADD COLUMN warehouse_id INT NULL REFERENCES warehouses(id),
  ADD COLUMN discount_amount DECIMAL(18, 2) NOT NULL DEFAULT 0;

ALTER TABLE sale_document_lines
  ADD COLUMN product_id INT NULL REFERENCES products(id);
