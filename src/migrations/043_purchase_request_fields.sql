-- "Permintaan Pembelian" (purchase request) is the one doc type with no pricing at
-- all (line items are qty/unit only -- purchase_document_lines' existing amount/tax
-- columns just stay 0) but needs its own extra header fields: a designated approver
-- (informational only -- this app has no per-user permission enforcement elsewhere
-- either, so anyone can still actually click Approve), an urgency level, and a related
-- budget year.
ALTER TABLE purchase_documents
  ADD COLUMN approver_user_id INT NULL REFERENCES users(id),
  ADD COLUMN approver_email VARCHAR(191) NULL,
  ADD COLUMN urgency ENUM('low', 'medium', 'high', 'urgent') NULL,
  ADD COLUMN budget_year VARCHAR(10) NULL;
