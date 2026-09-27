-- "Nama bank" on the account creation screen (shown only for Kas & Bank category
-- accounts, per the reference screen) -- purely descriptive, no live bank connection
-- exists in this app (see cashBank.controller.ts).
ALTER TABLE accounts ADD COLUMN bank_name VARCHAR(100) NULL;
