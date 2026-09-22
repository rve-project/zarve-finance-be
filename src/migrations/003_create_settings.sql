CREATE TABLE IF NOT EXISTS app_settings (
  id INT PRIMARY KEY DEFAULT 1,
  ev_keywords VARCHAR(500) NOT NULL DEFAULT 'vinfast,ev,listrik,denza,ioniq,vfe,wuling,byd',
  default_income_account_ev_id INT NULL,
  default_income_account_fuel_id INT NULL,
  auto_create_payment TINYINT(1) NOT NULL DEFAULT 1,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT chk_app_settings_singleton CHECK (id = 1),
  CONSTRAINT fk_app_settings_ev_account FOREIGN KEY (default_income_account_ev_id) REFERENCES accounts(id),
  CONSTRAINT fk_app_settings_fuel_account FOREIGN KEY (default_income_account_fuel_id) REFERENCES accounts(id)
);

INSERT INTO app_settings (id) VALUES (1) ON DUPLICATE KEY UPDATE id = id;
