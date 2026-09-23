-- "Penyesuaian Stok" -- matches Mekari's flow: pick a type/category/account/date/
-- warehouse first, then list which products change and by how much. Real effect: each
-- line updates the product's flat current_stock (still one number, not split per
-- warehouse -- "Gudang" here is descriptive metadata only, same caveat as the rest of
-- the Produk/Gudang feature), and if the product has a default inventory account, the
-- value change is posted as a real journal entry against the chosen adjustment account.
-- "Kategori penyesuaian" is a hardcoded, fixed list (Umum/Barang Rusak/Produksi/
-- Kuantitas Awal) -- not Settings-managed, there are only ever these four values.
CREATE TABLE stock_adjustments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_unit ENUM('zarve', 'b2b') NOT NULL DEFAULT 'b2b',
  adjustment_number VARCHAR(50) NOT NULL,
  type ENUM('count', 'in_out') NOT NULL DEFAULT 'count',
  category ENUM('general', 'damaged', 'production', 'opening_quantity') NOT NULL DEFAULT 'general',
  account_id INT NULL,
  warehouse_id INT NULL,
  adjustment_date DATE NOT NULL,
  memo TEXT NULL,
  journal_entry_id INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_stock_adjustments_unit_number (business_unit, adjustment_number),
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id)
);

CREATE TABLE stock_adjustment_lines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  stock_adjustment_id INT NOT NULL,
  product_id INT NOT NULL,
  stock_before DECIMAL(14, 2) NOT NULL,
  stock_after DECIMAL(14, 2) NOT NULL,
  FOREIGN KEY (stock_adjustment_id) REFERENCES stock_adjustments(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);
