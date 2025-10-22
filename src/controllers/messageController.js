// src/controllers/messageController.js
const db = require("../config/db");

// Create new message
const createMessage = async (req, res) => {
  const { sender_type, sender_id, receiver_type, receiver_id, shop_id, message_text } = req.body;

  if (!sender_type || !sender_id || !receiver_type || !receiver_id || !shop_id || !message_text) {
    return res.status(400).json({ error: "All fields are required" });
  }

  try {
    const sql = `
      INSERT INTO messages (sender_type, sender_id, receiver_type, receiver_id, shop_id, message_text)
      VALUES (?, ?, ?, ?, ?, ?)
    `;

    const [result] = await db.query(sql, [sender_type, sender_id, receiver_type, receiver_id, shop_id, message_text]);

    res.status(201).json({ message: "Message created successfully", message_id: result.insertId });
  } catch (err) {
    console.error("Error creating message:", err);
    res.status(500).json({ error: "Database error" });
  }
};

// Get all messages between a customer and admin for a shop
const getConversation = async (req, res) => {
  const { customerId, adminId, shopId } = req.params;

  try {
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

    const [results] = await db.query(sql, [shopId, customerId, adminId, adminId, customerId]);
    res.json(results);
  } catch (err) {
    console.error("Error fetching conversation:", err);
    res.status(500).json({ error: "Database error" });
  }
};

// Get all messages for a shop (optional, pang history/admin view)
const getMessagesByShop = async (req, res) => {
  const { shopId } = req.params;

  try {
    const sql = "SELECT * FROM messages WHERE shop_id = ? ORDER BY created_at DESC";
    const [results] = await db.query(sql, [shopId]);
    res.json(results);
  } catch (err) {
    console.error("Error fetching shop messages:", err);
    res.status(500).json({ error: "Database error" });
  }
};

// Get all conversations for a user
const getConversations = async (req, res) => {
  const { userType, userId } = req.params;

  try {
    let sql;
    if (userType === 'customer') {
      sql = `
        SELECT DISTINCT 
          m.shop_id,
          m.receiver_id as contact_id,
          m.receiver_type as contact_type,
          s.shop_name as contact_name,
          (SELECT message_text FROM messages 
           WHERE shop_id = m.shop_id 
           AND ((sender_type = 'customer' AND sender_id = ? AND receiver_type = 'admin') 
                OR (sender_type = 'admin' AND receiver_type = 'customer' AND receiver_id = ?))
           ORDER BY created_at DESC LIMIT 1) as last_message,
          (SELECT created_at FROM messages 
           WHERE shop_id = m.shop_id 
           AND ((sender_type = 'customer' AND sender_id = ? AND receiver_type = 'admin') 
                OR (sender_type = 'admin' AND receiver_type = 'customer' AND receiver_id = ?))
           ORDER BY created_at DESC LIMIT 1) as last_message_time
        FROM messages m
        LEFT JOIN shops s ON m.shop_id = s.shop_id
        WHERE (m.sender_type = 'customer' AND m.sender_id = ?) 
           OR (m.receiver_type = 'customer' AND m.receiver_id = ?)
        ORDER BY last_message_time DESC
      `;
      const [results] = await db.query(sql, [userId, userId, userId, userId, userId, userId]);
      res.json(results);
    } else {
      // For admin users
      sql = `
        SELECT DISTINCT 
          m.shop_id,
          m.sender_id as contact_id,
          m.sender_type as contact_type,
          CONCAT(c.first_name, ' ', c.last_name) as contact_name,
          (SELECT message_text FROM messages 
           WHERE shop_id = m.shop_id 
           AND ((sender_type = 'customer' AND receiver_type = 'admin' AND receiver_id = ?) 
                OR (sender_type = 'admin' AND sender_id = ? AND receiver_type = 'customer'))
           ORDER BY created_at DESC LIMIT 1) as last_message,
          (SELECT created_at FROM messages 
           WHERE shop_id = m.shop_id 
           AND ((sender_type = 'customer' AND receiver_type = 'admin' AND receiver_id = ?) 
                OR (sender_type = 'admin' AND sender_id = ? AND receiver_type = 'customer'))
           ORDER BY created_at DESC LIMIT 1) as last_message_time
        FROM messages m
        LEFT JOIN customer c ON m.sender_id = c.customer_id AND m.sender_type = 'customer'
        WHERE (m.receiver_type = 'admin' AND m.receiver_id = ?) 
           OR (m.sender_type = 'admin' AND m.sender_id = ?)
        ORDER BY last_message_time DESC
      `;
      const [results] = await db.query(sql, [userId, userId, userId, userId, userId, userId]);
      res.json(results);
    }
  } catch (err) {
    console.error("Error fetching conversations:", err);
    res.status(500).json({ error: "Database error" });
  }
};

module.exports = {
  createMessage,
  getConversation,
  getMessagesByShop,
  getConversations
};
