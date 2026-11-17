-- Allow requests to be created before a service or final price is assigned.
-- Recreate fk_booking_service with the existing cascade rules while making
-- service_id nullable.
ALTER TABLE booking
  DROP FOREIGN KEY fk_booking_service,
  MODIFY COLUMN service_id INT(11) NULL,
  MODIFY COLUMN total_amount DECIMAL(7,2) NULL,
  ADD COLUMN request_idempotency_key CHAR(36) NULL,
  ADD UNIQUE KEY uq_booking_request_idempotency_key (request_idempotency_key),
  ADD CONSTRAINT fk_booking_service FOREIGN KEY (service_id)
    REFERENCES services (service_id)
    ON DELETE CASCADE
    ON UPDATE CASCADE;
