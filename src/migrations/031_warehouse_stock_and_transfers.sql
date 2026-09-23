-- Real per-warehouse stock, enabling "Transfer Gudang" -- a transfer moves qty between
-- two warehouse allocations, it doesn't create or destroy stock. products.current_stock
-- stays the TOTAL across all allocations (kept in sync by every mutating operation, so
-- existing reads of it -- product list, stat cards, stock adjustment -- don't need to
-- change). NULL warehouse_id = "Unassigned", matching the Gudang dropdown's default;
-- no DB-level uniqueness on (product_id, warehouse_id) since MySQL treats every NULL as
-- distinct in a unique index -- upserts use a NULL-safe lookup in application code
-- instead.
CREATE TABLE product_warehouse_stock (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  warehouse_id INT NULL,
  qty DECIMAL(14, 2) NOT NULL DEFAULT 0,
  FOREIGN KEY (product_id) REFERENCES products(id),
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
);

-- Backfill: every stock-tracked product's existing current_stock becomes its
-- "Unassigned" allocation (nothing has been counted into a specific warehouse yet).
INSERT INTO product_warehouse_stock (product_id, warehouse_id, qty)
SELECT id, NULL, current_stock FROM products WHERE track_inventory = TRUE;

CREATE TABLE warehouse_transfers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_unit ENUM('zarve', 'b2b') NOT NULL DEFAULT 'b2b',
  transfer_number VARCHAR(50) NOT NULL,
  from_warehouse_id INT NULL,
  to_warehouse_id INT NULL,
  transfer_date DATE NOT NULL,
  memo TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_warehouse_transfers_unit_number (business_unit, transfer_number),
  FOREIGN KEY (from_warehouse_id) REFERENCES warehouses(id),
  FOREIGN KEY (to_warehouse_id) REFERENCES warehouses(id)
);

CREATE TABLE warehouse_transfer_lines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  warehouse_transfer_id INT NOT NULL,
  product_id INT NOT NULL,
  qty_before DECIMAL(14, 2) NOT NULL,
  qty_after DECIMAL(14, 2) NOT NULL,
  qty_transferred DECIMAL(14, 2) NOT NULL,
  FOREIGN KEY (warehouse_transfer_id) REFERENCES warehouse_transfers(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE warehouse_transfer_attachments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  warehouse_transfer_id INT NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  url VARCHAR(500) NOT NULL,
  FOREIGN KEY (warehouse_transfer_id) REFERENCES warehouse_transfers(id)
);
