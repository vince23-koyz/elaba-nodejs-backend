ALTER TABLE messages
  ADD COLUMN reply_to_message_id INT NULL AFTER message_text,
  ADD CONSTRAINT fk_messages_reply_to
    FOREIGN KEY (reply_to_message_id) REFERENCES messages(message_id)
    ON DELETE SET NULL;
