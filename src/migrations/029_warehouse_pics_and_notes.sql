-- "Tambah gudang baru" moves to its own page (matching Mekari's), which lets more than
-- one Penanggung Jawab be picked (up to 5, enforced frontend-side) instead of one, plus
-- a free-text "Keterangan" field. Mekari's hint text about PIC email reminders (low
-- stock / expiring batch alerts) is shown for context but not implemented -- storing
-- the PIC list is real, sending reminders is not (no batch tracking exists yet either).
CREATE TABLE warehouse_pics (
  warehouse_id INT NOT NULL,
  user_id INT NOT NULL,
  PRIMARY KEY (warehouse_id, user_id),
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Backfill any existing single PIC into the new join table before dropping the column.
INSERT INTO warehouse_pics (warehouse_id, user_id)
SELECT id, person_in_charge_user_id FROM warehouses WHERE person_in_charge_user_id IS NOT NULL;

ALTER TABLE warehouses
  DROP FOREIGN KEY warehouses_ibfk_1,
  DROP COLUMN person_in_charge_user_id,
  ADD COLUMN notes TEXT NULL,
  MODIFY COLUMN name VARCHAR(255) NOT NULL;
