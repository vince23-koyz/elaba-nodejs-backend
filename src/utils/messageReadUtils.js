const buildMarkReadQuery = ({ senderId, receiverId, shopId, senderType, receiverType }) => {
  if (senderType && receiverType) {
    return {
      sql: `
        UPDATE messages
        SET is_read = 1
        WHERE shop_id = ?
          AND is_read = 0
          AND sender_type = ?
          AND sender_id = ?
          AND receiver_type = ?
          AND receiver_id = ?
      `,
      params: [shopId, senderType, senderId, receiverType, receiverId],
    };
  }

  return {
    sql: `
      UPDATE messages
      SET is_read = 1
      WHERE shop_id = ? AND is_read = 0
      AND (
        (sender_id = ? AND receiver_id = ?)
        OR (sender_id = ? AND receiver_id = ?)
      )
    `,
    params: [shopId, senderId, receiverId, receiverId, senderId],
  };
};

module.exports = {
  buildMarkReadQuery,
};
