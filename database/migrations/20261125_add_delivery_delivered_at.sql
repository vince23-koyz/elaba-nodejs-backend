SET @delivered_at_exists = (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'delivery'
    AND column_name = 'delivered_at'
);

SET @delivered_at_migration = IF(
  @delivered_at_exists = 0,
  'ALTER TABLE delivery ADD COLUMN delivered_at DATETIME NULL DEFAULT NULL',
  'SELECT ''delivery.delivered_at already exists'''
);

PREPARE delivered_at_statement FROM @delivered_at_migration;
EXECUTE delivered_at_statement;
DEALLOCATE PREPARE delivered_at_statement;
