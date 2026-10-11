-- "Pajak Gabungan" -- a tax code that's really a preset bundle of 2+ existing tax
-- codes (e.g. "PPN 11% + PPH 23 2%"), selectable as ONE option in a line's Pajak
-- dropdown instead of the line only ever carrying a single tax. Each component keeps
-- its own rate and its own "akun penampung" (taxes.account_id, see migration
-- 052_tax_account.sql) -- posting always routes through the COMPONENT's account, never
-- the group row's own account_id, which stays NULL for a compound tax.
--
-- `sign` says whether a component adds to or subtracts from the line total relative to
-- the group's net rate: PPN adds (output/input tax on top of the price), PPH 23
-- subtracts (withheld from what you pay/receive, remitted to the tax office yourself,
-- and posted to its own payable account instead of PPN Keluaran/Masukan). The group's
-- own `rate` column is set to the signed sum of its components' rates (e.g. 11 - 2 = 9)
-- on create/update, so the existing single-rate `amount * rate/100` computation already
-- used everywhere on the frontend keeps working completely unchanged for a compound
-- tax -- only journal *posting* (resolveTaxJournalLines in utils/ledger.ts) needs to
-- know about the individual components, to split the net amount back out across each
-- component's own account.
ALTER TABLE taxes ADD COLUMN is_compound BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE tax_components (
  id INT AUTO_INCREMENT PRIMARY KEY,
  group_tax_id INT NOT NULL,
  component_tax_id INT NOT NULL,
  sign ENUM('add', 'subtract') NOT NULL DEFAULT 'add',
  FOREIGN KEY (group_tax_id) REFERENCES taxes(id) ON DELETE CASCADE,
  FOREIGN KEY (component_tax_id) REFERENCES taxes(id)
);
