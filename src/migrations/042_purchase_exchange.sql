-- "Tukar Faktur Pembelian" (purchase exchange/credit note) doesn't buy anything new --
-- each line instead picks an existing APPROVED purchase invoice and an amount to
-- credit against it, reducing that invoice's own outstanding balance. Reuses
-- purchase_document_lines (amount = the credited amount, no product/account/qty/tax)
-- rather than a new table, same "one flexible lines table" approach as the rest of
-- this module.
ALTER TABLE purchase_document_lines
  ADD COLUMN target_document_id INT NULL REFERENCES purchase_documents(id);
