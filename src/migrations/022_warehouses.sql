-- "Gudang" (Warehouse) list only for now -- "Daftar gudang" is real; "Daftar transfer
-- gudang" and "Membutuhkan persetujuan" stay empty-state placeholders since stock
-- isn't split per warehouse yet (products.current_stock stays one flat number, per
-- the client's own call to keep it simple for now).
CREATE TABLE warehouses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_unit ENUM('zarve', 'b2b') NOT NULL DEFAULT 'b2b',
  code VARCHAR(50) NOT NULL,
  name VARCHAR(191) NOT NULL,
  person_in_charge_user_id INT NULL,
  address TEXT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_warehouses_unit_code (business_unit, code),
  FOREIGN KEY (person_in_charge_user_id) REFERENCES users(id)
);
