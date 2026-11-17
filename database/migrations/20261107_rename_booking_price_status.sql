-- Rename the legacy quote workflow field to describe its actual purpose.
-- Preserve the customer-review step and normalize the retired "quoted" state.
ALTER TABLE booking
  CHANGE COLUMN quote_status price_confirmation_status VARCHAR(32) NULL DEFAULT NULL;

UPDATE booking
SET price_confirmation_status = 'awaiting_customer'
WHERE price_confirmation_status = 'quoted';
