-- "Pemenuhan" (order fulfillment) board for B2B, matching Mekari Jurnal's Penjualan /
-- Pembelian kanban: Pesanan Baru -> Sedang Diproses -> Sedang Dikirim -> Selesai, or
-- Dibatalkan. This is purely an operational/logistics tracker (status is moved
-- manually, same as Mekari's own board -- no live courier integration) and is
-- deliberately NOT wired into the ledger: no journal entry is posted from here,
-- matching how Mekari itself keeps fulfillment separate from accounting.
CREATE TABLE orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_unit ENUM('zarve', 'b2b') NOT NULL DEFAULT 'b2b',
  type ENUM('sale', 'purchase') NOT NULL,
  order_number VARCHAR(50) NOT NULL,
  party_name VARCHAR(191) NOT NULL,
  order_date DATE NOT NULL,
  amount DECIMAL(14, 2) NOT NULL DEFAULT 0,
  status ENUM('new', 'processing', 'shipping', 'completed', 'cancelled') NOT NULL DEFAULT 'new',
  notes TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_orders_unit_type_number (business_unit, type, order_number),
  INDEX idx_orders_unit_type_status (business_unit, type, status)
);
