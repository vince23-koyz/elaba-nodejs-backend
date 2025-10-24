// src/routes/messageRoutes.js
const express = require("express");
const router = express.Router();
const {
  createMessage,
  getConversation,
  getMessagesByShop,
  getConversations,
  markMessagesAsRead
} = require("../controllers/messageController");

// Create a new message
router.post("/", createMessage);

// Get conversation between a customer and an admin for a shop
router.get("/conversation/:customerId/:adminId/:shopId", getConversation);

// Get all messages for a shop
router.get("/shop/:shopId", getMessagesByShop);

// Get all conversations for a user
router.get("/conversations/:userType/:userId", getConversations);

// Mark all messages as read for a conversation (when user opens chat)
// Expects body: { senderId, receiverId, shopId }
router.put("/mark-read", markMessagesAsRead);

// Test endpoint to create sample data
router.post("/test-data", (req, res) => {
  const db = require("../config/db");
  
  // Insert test customer
  const insertCustomer = `INSERT IGNORE INTO customer (customer_id, first_name, last_name, username, phone_number, password_hash)
    VALUES (999, 'Test', 'Customer', 'testcustomer', '09999999999', '$2a$10$test')`;
  
  db.query(insertCustomer, (err) => {
    if (err) console.log('Customer insert error:', err);
    
    // Insert test messages
    const insertMessage1 = `INSERT INTO messages (sender_type, sender_id, receiver_type, receiver_id, shop_id, message_text, created_at)
      VALUES ('customer', '999', 'admin', '1', '1', 'Hello from test customer!', NOW())`;
    
    const insertMessage2 = `INSERT INTO messages (sender_type, sender_id, receiver_type, receiver_id, shop_id, message_text, created_at)
      VALUES ('customer', '999', 'admin', '1', '1', 'This is a test message for staff app', NOW())`;
    
    db.query(insertMessage1, (err1) => {
      if (err1) console.log('Message 1 insert error:', err1);
      
      db.query(insertMessage2, (err2) => {
        if (err2) console.log('Message 2 insert error:', err2);
        
        res.json({ success: true, message: 'Test data created successfully!' });
      });
    });
  });
});

module.exports = router;
