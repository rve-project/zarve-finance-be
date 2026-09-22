-- Local read cache of the live Zarve API's data. Every page that used to call Zarve
-- live on each request (Beranda, Rekap Revenue, Driver Revenue Recap, Invoice menu,
-- dashboard summary) now queries these tables instead -- a manual "Sync Sekarang"
-- action (see zarveMirrorSync.ts) is what refreshes them. Invoice line-item detail is
-- the one exception left as a live single-record call (see zarveInvoices.controller.ts)
-- since it's only ever fetched one at a time, on demand.

CREATE TABLE IF NOT EXISTS zarve_companies (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  code VARCHAR(50) NULL
);

CREATE TABLE IF NOT EXISTS zarve_categories (
  id VARCHAR(36) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  company_id VARCHAR(36) NULL,
  engine_type VARCHAR(50) NULL
);

CREATE TABLE IF NOT EXISTS zarve_vehicles (
  id VARCHAR(36) PRIMARY KEY,
  plate_number VARCHAR(50) NOT NULL,
  category_id VARCHAR(36) NULL,
  company_id VARCHAR(36) NULL,
  INDEX idx_zarve_vehicles_category (category_id)
);

CREATE TABLE IF NOT EXISTS zarve_invoices (
  id VARCHAR(36) PRIMARY KEY,
  invoice_number VARCHAR(100) NULL,
  booking_id VARCHAR(36) NOT NULL,
  order_number VARCHAR(100) NULL,
  company_id VARCHAR(36) NULL,
  driver_id VARCHAR(36) NULL,
  driver_name VARCHAR(255) NULL,
  driver_nik VARCHAR(32) NULL,
  driver_phone VARCHAR(32) NULL,
  vehicle_id VARCHAR(36) NULL,
  vehicle_plate VARCHAR(50) NULL,
  vehicle_category_name VARCHAR(255) NULL,
  vehicle_engine_type VARCHAR(50) NULL,
  booking_end_date DATE NULL,
  booking_status VARCHAR(30) NULL,
  invoice_date DATE NOT NULL,
  type VARCHAR(30) NOT NULL,
  total DECIMAL(14, 2) NOT NULL DEFAULT 0,
  amount_paid DECIMAL(14, 2) NOT NULL DEFAULT 0,
  total_discount DECIMAL(14, 2) NOT NULL DEFAULT 0,
  status VARCHAR(30) NOT NULL,
  payment_method VARCHAR(50) NULL,
  paid_at DATETIME NULL,
  payment_timeliness VARCHAR(30) NULL,
  late_days INT NULL,
  created_at_zarve DATETIME NULL,
  synced_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_zarve_invoices_booking (booking_id),
  INDEX idx_zarve_invoices_vehicle (vehicle_id),
  INDEX idx_zarve_invoices_date (invoice_date),
  INDEX idx_zarve_invoices_status (status),
  INDEX idx_zarve_invoices_type (type)
);

CREATE TABLE IF NOT EXISTS zarve_vehicle_status_histories (
  id VARCHAR(36) PRIMARY KEY,
  vehicle_id VARCHAR(36) NOT NULL,
  status VARCHAR(30) NOT NULL,
  note VARCHAR(500) NULL,
  booking_id VARCHAR(36) NULL,
  driver_id VARCHAR(36) NULL,
  created_at_zarve DATETIME NOT NULL,
  INDEX idx_zarve_vsh_vehicle (vehicle_id, created_at_zarve)
);

CREATE TABLE IF NOT EXISTS zarve_sync_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  started_at TIMESTAMP NOT NULL,
  finished_at TIMESTAMP NULL,
  phase VARCHAR(255) NULL,
  total_invoices INT NOT NULL DEFAULT 0,
  total_vehicles INT NOT NULL DEFAULT 0,
  total_status_histories INT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'running',
  error_message TEXT NULL
);
