-- "Produk" (Barang & Jasa) for B2B, matching Mekari Jurnal's Produk > Barang & jasa
-- tab. Gudang and Aturan Harga are deferred -- this covers product master data only.
-- Stock is a plain manual number on the product row (no warehouse/movement ledger
-- yet), and "Harga rata-rata" / "Harga beli terakhir" from the reference are
-- deliberately NOT modeled here since there's no purchase-history to compute them
-- from -- only the real, directly-entered "Harga beli" and "Harga jual" exist.
CREATE TABLE product_categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_unit ENUM('zarve', 'b2b') NOT NULL DEFAULT 'b2b',
  name VARCHAR(100) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_product_categories_unit_name (business_unit, name)
);

CREATE TABLE products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_unit ENUM('zarve', 'b2b') NOT NULL DEFAULT 'b2b',
  type ENUM('barang', 'jasa') NOT NULL DEFAULT 'barang',
  name VARCHAR(191) NOT NULL,
  code VARCHAR(50) NOT NULL,
  category_id INT NULL,
  unit VARCHAR(50) NULL,
  purchase_price DECIMAL(14, 2) NOT NULL DEFAULT 0,
  selling_price DECIMAL(14, 2) NOT NULL DEFAULT 0,
  track_inventory BOOLEAN NOT NULL DEFAULT FALSE,
  current_stock DECIMAL(14, 2) NULL,
  min_stock DECIMAL(14, 2) NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_products_unit_code (business_unit, code),
  FOREIGN KEY (category_id) REFERENCES product_categories(id)
);
