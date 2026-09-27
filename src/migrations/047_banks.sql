-- "Nama bank" list for the B2B "Buat akun baru" screen's Kas & Bank bank picker --
-- previously a hardcoded frontend list; now editable via Settings, same pattern as
-- taxes (017_account_categories_and_taxes.sql).
CREATE TABLE banks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_unit ENUM('zarve', 'b2b') NOT NULL DEFAULT 'b2b',
  name VARCHAR(100) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO banks (business_unit, name) VALUES
  ('b2b', 'BCA'),
  ('b2b', 'Mandiri'),
  ('b2b', 'BNI'),
  ('b2b', 'BRI'),
  ('b2b', 'CIMB Niaga'),
  ('b2b', 'Permata'),
  ('b2b', 'Danamon'),
  ('b2b', 'OCBC NISP'),
  ('b2b', 'Maybank'),
  ('b2b', 'Bank Lainnya');
