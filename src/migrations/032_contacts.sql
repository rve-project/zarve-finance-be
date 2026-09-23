-- "Kontak" -- a B2B-only contact book (Pelanggan/Supplier/Karyawan/Lainnya), matching
-- Mekari's "Kontak" screen. Deliberately a NEW table, not an extension of the existing
-- `partners` table -- partners is tightly coupled to Zarve's driver-import matching
-- logic (findOrCreatePartner, ktp+name dedup) and invoice/payment references; B2B gets
-- its own separate contact data instead of risking that machinery.
CREATE TABLE contacts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_unit ENUM('zarve', 'b2b') NOT NULL DEFAULT 'b2b',
  type ENUM('customer', 'vendor', 'employee', 'other') NOT NULL DEFAULT 'customer',
  name VARCHAR(191) NOT NULL,
  company_name VARCHAR(191) NULL,
  address TEXT NULL,
  email VARCHAR(191) NULL,
  mobile_phone VARCHAR(50) NULL,
  phone VARCHAR(50) NULL,
  npwp VARCHAR(50) NULL,
  notes TEXT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
