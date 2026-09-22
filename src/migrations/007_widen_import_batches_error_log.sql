-- Posting now runs against everything the mirror has (not one picked month), so the
-- warnings list on a large run can be considerably longer than TEXT's ~64KB cap.
ALTER TABLE import_batches MODIFY COLUMN error_log MEDIUMTEXT NULL;
