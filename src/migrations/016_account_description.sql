-- Free-text notes per account (the B2B "Daftar Akun" page's create form has a
-- Deskripsi field, matching Mekari Jurnal's chart-of-accounts UI). Optional, purely
-- informational -- nothing else in the app reads it.
ALTER TABLE accounts ADD COLUMN description TEXT NULL;
