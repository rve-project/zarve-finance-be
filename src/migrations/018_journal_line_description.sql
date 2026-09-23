-- Per-line description ("Deskripsi" column) for the redesigned manual journal entry
-- form -- previously only the whole entry had a narration, not each line.
ALTER TABLE journal_lines ADD COLUMN description VARCHAR(255) NULL;
