-- "Syarat Pembayaran" (payment terms, e.g. "Net 30") -- was a hardcoded list duplicated
-- across SaleForm.tsx, PurchaseForm.tsx, SaleExchangeForm.tsx, PurchaseExchangeForm.tsx
-- and the Contacts form, with no way to add a new one. Mirrors banks.controller.ts's
-- pattern exactly, editable via Settings instead. `days` is how many days after the
-- document date the due date auto-fills to; NULL means "Custom" -- the due date stays
-- whatever the user picks manually, matching the pre-existing behavior of the
-- hardcoded "Custom" entry (see selectPaymentTerm() in SaleForm.tsx/PurchaseForm.tsx).
CREATE TABLE payment_terms (
  id INT AUTO_INCREMENT PRIMARY KEY,
  business_unit ENUM('zarve', 'b2b') NOT NULL DEFAULT 'b2b',
  name VARCHAR(100) NOT NULL,
  days INT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Seed with the union of every form's hardcoded set (SaleForm/PurchaseForm used
-- COD/15/30/60/Custom; the Contacts form separately used COD/7/14/30/60) so switching
-- them all over to this one shared table drops none of the options anyone could
-- already pick.
INSERT INTO payment_terms (business_unit, name, days) VALUES
  ('b2b', 'Cash on Delivery', 0),
  ('b2b', 'Net 7', 7),
  ('b2b', 'Net 14', 14),
  ('b2b', 'Net 15', 15),
  ('b2b', 'Net 30', 30),
  ('b2b', 'Net 60', 60),
  ('b2b', 'Custom', NULL);
