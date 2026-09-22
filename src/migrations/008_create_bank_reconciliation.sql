-- Bank reconciliation: sweeps payments sitting in Undeposited Funds into a real
-- bank/cash account, matching Odoo Accounting's bank reconciliation step (which this
-- system didn't have yet -- every payment posted straight to Undeposited Funds with
-- no way to move it out). One reconciliation batch = one journal entry (debit the
-- chosen bank account, credit Undeposited Funds) covering however many payments were
-- selected -- one at a time or all at once.
CREATE TABLE bank_reconciliations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  bank_account_id INT NOT NULL,
  date DATE NOT NULL,
  total_amount DECIMAL(14, 2) NOT NULL,
  payment_count INT NOT NULL,
  journal_entry_id INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (bank_account_id) REFERENCES accounts(id),
  FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id)
);

ALTER TABLE payments ADD COLUMN reconciliation_id INT NULL, ADD FOREIGN KEY (reconciliation_id) REFERENCES bank_reconciliations(id);
CREATE INDEX idx_payments_reconciliation ON payments (reconciliation_id);
