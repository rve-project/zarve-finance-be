-- D'Consulting audit gap #10: no audit trail of who did what exists anywhere in this
-- system (no created_by/updated_by column on any table). Adds a single global activity
-- log, populated by one middleware hook (see middlewares/auditLog.ts) instead of
-- touching every controller -- captures every mutating (POST/PUT/PATCH/DELETE) request
-- from an authenticated user.
CREATE TABLE activity_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  business_unit ENUM('zarve', 'b2b') NULL,
  method VARCHAR(10) NOT NULL,
  path VARCHAR(255) NOT NULL,
  resource_type VARCHAR(100) NULL,
  resource_id VARCHAR(50) NULL,
  request_body JSON NULL,
  response_status INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  INDEX idx_activity_logs_user (user_id),
  INDEX idx_activity_logs_resource (resource_type, resource_id),
  INDEX idx_activity_logs_created (created_at)
);

-- "Beberapa key user" from the consultant's note -- who gets to VIEW the log above.
-- `role` on `users` only ever has the single value 'admin' (everyone), so it can't
-- express "some" users; this is a plain per-user flag an existing admin toggles.
ALTER TABLE users ADD COLUMN can_view_activity_log BOOLEAN NOT NULL DEFAULT FALSE;
