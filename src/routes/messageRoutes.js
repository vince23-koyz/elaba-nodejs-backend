// src/routes/messageRoutes.js
const express = require("express");
const router = express.Router();
const {
  createMessage,
  getConversation,
  getMessagesByShop
} = require("../controllers/messageController");

// Create a new message
router.post("/", createMessage);

// Get conversation between a customer and an admin for a shop
router.get("/conversation/:customerId/:adminId/:shopId", getConversation);

// Get all messages for a shop
router.get("/shop/:shopId", getMessagesByShop);

module.exports = router;
