-- Tutup Buku (close period): transactions older than `period_lock_days` can no longer
-- write to the ledger directly -- the write must come with an approved correction
-- request instead. See utils/periodLock.ts for how this is enforced.
ALTER TABLE app_settings ADD COLUMN period_lock_days INT NOT NULL DEFAULT 30;

-- "Pihak berwenang" from the stakeholder's request -- who gets to approve/reject a
-- correction request. Same reasoning as can_view_activity_log (049_activity_logs.sql):
-- `role` on `users` only ever has the single value 'admin', so it can't express "some"
-- users; this is a plain per-user flag an existing admin toggles.
ALTER TABLE users ADD COLUMN can_approve_corrections BOOLEAN NOT NULL DEFAULT FALSE;

-- One row per "please let me write to a closed period" ask. `resource_id` is NULL for a
-- manual journal entry that doesn't exist yet (it's only created once the request is
-- approved and the user retries); it's set to the existing record's id for an expense
-- edit/delete, a fixed asset revaluation, or a sale/purchase approval. `used_at` makes
-- an approved request single-use -- the write that consumes it claims it atomically
-- (see utils/periodLock.ts), so two different writes can never share one approval.
CREATE TABLE koreksi_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_unit ENUM('zarve', 'b2b') NOT NULL,
  resource_type ENUM('journal_entry', 'expense', 'fixed_asset_revaluation', 'sale_invoice_approval', 'purchase_invoice_approval') NOT NULL,
  resource_id INT NULL,
  requested_date DATE NOT NULL,
  reason TEXT NOT NULL,
  status ENUM('pending_approval', 'approved', 'rejected') NOT NULL DEFAULT 'pending_approval',
  requested_by INT NOT NULL,
  approved_by INT NULL,
  approved_at TIMESTAMP NULL,
  rejected_reason TEXT NULL,
  used_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (requested_by) REFERENCES users(id),
  FOREIGN KEY (approved_by) REFERENCES users(id),
  INDEX idx_koreksi_lookup (business_unit, resource_type, resource_id, requested_date, status)
);
