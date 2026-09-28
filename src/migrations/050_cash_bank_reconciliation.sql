-- D'Consulting audit gap #8 for B2B: the same tick-and-go bank reconciliation Zarve
-- already has (see reconciliation.controller.ts), adapted to how B2B actually works --
-- B2B journal lines already post straight to their final bank/cash account at creation
-- time (no "Undeposited Funds" holding step like Zarve), so reconciling here just means
-- marking which ledger lines have cleared the bank statement. No journal entry needs
-- posting; this only stamps the lines. The B2B Kas & Bank ledger page already had a
-- "Status" column hardcoded to always show "unreconciled" -- this is what makes it real.
CREATE TABLE cash_bank_reconciliations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_unit ENUM('zarve', 'b2b') NOT NULL DEFAULT 'b2b',
  account_id INT NOT NULL,
  reconciliation_date DATE NOT NULL,
  total_amount DECIMAL(18, 2) NOT NULL,
  line_count INT NOT NULL,
  created_by INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (created_by) REFERENCES users(id),
  INDEX idx_cash_bank_reconciliations_account (account_id)
);

ALTER TABLE journal_lines
  ADD COLUMN reconciled_at DATE NULL,
  ADD COLUMN reconciliation_batch_id INT NULL,
  ADD FOREIGN KEY (reconciliation_batch_id) REFERENCES cash_bank_reconciliations(id),
  ADD INDEX idx_journal_lines_reconciliation (reconciliation_batch_id);
