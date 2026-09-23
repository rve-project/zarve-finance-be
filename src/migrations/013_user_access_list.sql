-- The `users` table becomes rve-finance's access list: a Zarve account can only log in
-- here if an admin has registered its email first (see auth.controller.ts) -- previously
-- any valid Zarve account was auto-created on first login. Existing rows keep access.
ALTER TABLE users
  ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
