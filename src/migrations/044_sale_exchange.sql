-- "Tukar Faktur Penjualan" (Sales exchange / credit note) -- mirrors
-- migrations/042_purchase_exchange.sql, but crediting a Faktur Penjualan (reducing a
-- customer's outstanding receivable) instead of a Faktur Pembelian.
ALTER TABLE sale_documents MODIFY COLUMN doc_type
  ENUM('quotation', 'order', 'invoice', 'shipment', 'exchange') NOT NULL;

ALTER TABLE sale_document_lines
  ADD COLUMN target_document_id INT NULL REFERENCES sale_documents(id);
