-- "Komponen Bundle" -- which existing (qty-tracked, Single) products make up a Bundle
-- product, each with a qty, matching Mekari's bundle composition table shown when
-- Tipe Produk = Bundle. Also adds an optional "Akun biaya tambahan" account for
-- extra costs incurred assembling the bundle, on top of its components' own cost.
CREATE TABLE product_bundle_components (
  id INT AUTO_INCREMENT PRIMARY KEY,
  bundle_product_id INT NOT NULL,
  component_product_id INT NOT NULL,
  qty DECIMAL(14, 2) NOT NULL DEFAULT 1,
  FOREIGN KEY (bundle_product_id) REFERENCES products(id),
  FOREIGN KEY (component_product_id) REFERENCES products(id)
);

ALTER TABLE products
  ADD COLUMN bundle_extra_cost_account_id INT NULL,
  ADD FOREIGN KEY (bundle_extra_cost_account_id) REFERENCES accounts(id);
