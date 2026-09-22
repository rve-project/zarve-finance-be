-- Vehicle EV/fuel classification now comes straight from Zarve's own category.engineType
-- field during sync, not from name-keyword guessing -- this column is no longer read.
ALTER TABLE app_settings DROP COLUMN ev_keywords;
