// src/controllers/messageController.js
const db = require("../config/db");

// Create new message
const createMessage = (req, res) => {
  const { sender_type, sender_id, receiver_type, receiver_id, shop_id, message_text } = req.body;

  if (!sender_type || !sender_id || !receiver_type || !receiver_id || !shop_id || !message_text) {
    return res.status(400).json({ error: "All fields are required" });
  }

  const sql = `
    INSERT INTO messages (sender_type, sender_id, receiver_type, receiver_id, shop_id, message_text)
    VALUES (?, ?, ?, ?, ?, ?)
  `;

  db.query(sql, [sender_type, sender_id, receiver_type, receiver_id, shop_id, message_text], (err, result) => {
    if (err) {
      console.error("Error creating message:", err);
      return res.status(500).json({ error: "Database error" });
    }

    res.status(201).json({ message: "Message created successfully", message_id: result.insertId });
  });
};

// Get all messages between a customer and admin for a shop
const getConversation = (req, res) => {
  const { customerId, adminId, shopId } = req.params;

  const sql = `
    SELECT * FROM messages 
    WHERE shop_id = ? 
    AND (
      (sender_type = 'customer' AND sender_id = ? AND receiver_type = 'admin' AND receiver_id = ?)
      OR 
      (sender_type = 'admin' AND sender_id = ? AND receiver_type = 'customer' AND receiver_id = ?)
    )
    ORDER BY created_at ASC
  `;

  db.query(sql, [shopId, customerId, adminId, adminId, customerId], (err, results) => {
    if (err) {
      console.error("Error fetching conversation:", err);
      return res.status(500).json({ error: "Database error" });
    }

    res.json(results);
  });
};

// Get all messages for a shop (optional, pang history/admin view)
const getMessagesByShop = (req, res) => {
  const { shopId } = req.params;

  const sql = "SELECT * FROM messages WHERE shop_id = ? ORDER BY created_at DESC";

  db.query(sql, [shopId], (err, results) => {
    if (err) {
      console.error("Error fetching shop messages:", err);
      return res.status(500).json({ error: "Database error" });
    }

    res.json(results);
  });
};

module.exports = {
  createMessage,
  getConversation,
  getMessagesByShop
};
