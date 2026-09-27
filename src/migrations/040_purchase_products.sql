-- Matches the reference "Buat Faktur Pembelian" screen: lines pick a Produk (not a
-- raw account -- the account/inventory effect is resolved from the product itself),
-- plus the header fields shown there (Gudang, Email, No. referensi supplier, Tag,
-- Pesan vs Memo as two separate notes, Syarat Pembayaran, Pemotongan).
ALTER TABLE purchase_documents
  ADD COLUMN warehouse_id INT NULL REFERENCES warehouses(id),
  ADD COLUMN email VARCHAR(191) NULL,
  ADD COLUMN supplier_ref VARCHAR(100) NULL,
  ADD COLUMN tag VARCHAR(191) NULL,
  ADD COLUMN customer_note TEXT NULL,
  ADD COLUMN payment_term VARCHAR(50) NULL,
  ADD COLUMN discount_amount DECIMAL(18, 2) NOT NULL DEFAULT 0;

ALTER TABLE purchase_document_lines
  ADD COLUMN product_id INT NULL REFERENCES products(id);
