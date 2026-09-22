-- Geofence ("keluar kota") violations from Zarve's /working-area/violations. Mirrored
-- like everything else so the Driver Revenue Recap can flag which day a vehicle left
-- its working area without hitting Zarve live. `returned_at` isn't a field Zarve
-- provides directly -- it's derived at sync time from that vehicle's raw GPS history
-- (first OUT -> IN transition after detected_at), so it can be NULL when the device
-- has no retained history for that day.
CREATE TABLE zarve_geofence_violations (
  id VARCHAR(36) PRIMARY KEY,
  violation_date DATE NOT NULL,
  detected_at DATETIME NOT NULL,
  returned_at DATETIME NULL,
  latitude DECIMAL(10, 6) NULL,
  longitude DECIMAL(10, 6) NULL,
  price DECIMAL(14, 2) NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL,
  vehicle_id VARCHAR(36) NULL,
  vehicle_plate VARCHAR(50) NULL,
  geofence_name VARCHAR(100) NULL,
  driver_id VARCHAR(36) NULL,
  driver_name VARCHAR(255) NULL,
  booking_id VARCHAR(36) NULL,
  invoice_id VARCHAR(36) NULL,
  invoice_number VARCHAR(100) NULL,
  imei_number VARCHAR(50) NULL,
  synced_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_gv_vehicle_date (vehicle_id, violation_date)
);
