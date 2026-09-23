-- "Butuh akun diskon? Aktifkan sekarang" was dropped from the product form (not part
-- of Mekari's own flow) -- remove the never-used column added for it in
-- 024_product_discount_image.sql.
ALTER TABLE products DROP FOREIGN KEY products_ibfk_6;
ALTER TABLE products DROP COLUMN discount_account_id;
