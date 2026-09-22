-- Replaces the hand-copied ZARVE_API_TOKEN env var: the token used for background
-- mirror sync is now whatever token Zarve's own /auth/login handed back the last time
-- any user logged into rve-finance (see auth.controller.ts) -- refreshed automatically
-- on every login instead of needing someone to manually paste a new JWT into .env.
ALTER TABLE app_settings
  ADD COLUMN zarve_api_token TEXT NULL,
  ADD COLUMN zarve_api_token_updated_at TIMESTAMP NULL;
