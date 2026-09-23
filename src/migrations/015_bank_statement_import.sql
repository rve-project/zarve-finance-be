-- "Kas & Bank" page: for each cash/bank account, shows a "Saldo bank" figure
-- separate from "Saldo di Jurnal" (the real ledger balance) -- these two only agree
-- once someone imports the actual bank statement and/or reconciles. This app has no
-- live bank connection (that's a separate, much bigger integration, deliberately out
-- of scope) -- "Saldo bank" instead comes from manually importing a bank statement
-- file (see cashBank.controller.ts's `importStatement`). Bank accounts here are the
-- same `accounts` rows already used everywhere else (asset type, code prefix '11'),
-- not a separate bank-account master.
CREATE TABLE bank_statement_imports (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_id INT NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  total_lines INT NOT NULL,
  imported_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
);

CREATE TABLE bank_statement_lines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  import_id INT NOT NULL,
  account_id INT NOT NULL,
  statement_date DATE NOT NULL,
  description VARCHAR(255) NULL,
  debit DECIMAL(14, 2) NOT NULL DEFAULT 0,
  credit DECIMAL(14, 2) NOT NULL DEFAULT 0,
  balance DECIMAL(14, 2) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (import_id) REFERENCES bank_statement_imports(id),
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  INDEX idx_bank_statement_lines_account_date (account_id, statement_date, id)
);
