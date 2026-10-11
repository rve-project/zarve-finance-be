-- "Akun penampung" per tax code -- which GL account a tax's amount actually posts to
-- (e.g. PPN 11% -> 2-20500 PPN Keluaran, PPH 23 2% -> a withholding payable account),
-- instead of every tax on a document dumping into one hardcoded PPN Keluaran/Masukan
-- account regardless of which tax code was picked. NULL keeps the old hardcoded-account
-- fallback (see sales/purchases/expenses.controller.ts), so existing tax codes with no
-- account set behave exactly as before this migration.
ALTER TABLE taxes ADD COLUMN account_id INT NULL, ADD FOREIGN KEY (account_id) REFERENCES accounts(id);
