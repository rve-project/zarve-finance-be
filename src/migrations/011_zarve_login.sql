-- Lets rve-finance users log in with their Zarve account (email + password) instead
-- of a separate local password. `password_hash` becomes nullable: every user logs in
-- via Zarve now, so none of them (including the old admin@rve.local row) has a local
-- password hash anymore -- it's verified against Zarve's API fresh on every login.
ALTER TABLE users
  MODIFY password_hash VARCHAR(255) NULL,
  ADD COLUMN zarve_user_id VARCHAR(36) NULL UNIQUE AFTER email;
