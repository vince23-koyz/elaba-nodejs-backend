const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const http = require('http'); 
const { Server } = require('socket.io');

const customerRoutes = require('./routes/customerRoutes');
const adminRoutes = require('./routes/adminRoutes');
const shopRoutes = require('./routes/shopRoutes');
const serviceRoutes = require('./routes/serviceRoutes');
const bookingRoutes = require('./routes/bookingRoutes');
const deliveryRoutes = require('./routes/deliveryRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const messageRoutes = require('./routes/messageRoutes');

const app = express();
const PORT = 5000;

// Create HTTP server
const server = http.createServer(app);

// Setup Socket.IO
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Routes
app.use('/api/customers', customerRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/shop', shopRoutes);
app.use('/api/service', serviceRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/delivery', deliveryRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/messages', messageRoutes);

// Socket.IO events
io.on('connection', (socket) => {
  console.log('🟢 A user connected:', socket.id);

  // Join user to a room
  socket.on('join', (userData) => {
    const { userId, userType } = userData;
    const roomId = `user_${userType}_${userId}`;
    socket.join(roomId);
    console.log(`👤 User ${userId} (${userType}) joined room: ${roomId}`);
  });

  // Join conversation room
  socket.on('joinConversation', (conversationId) => {
    socket.join(conversationId);
    console.log(`💬 User joined conversation: ${conversationId}`);
  });

  // Leave conversation room
  socket.on('leaveConversation', (conversationId) => {
    socket.leave(conversationId);
    console.log(`👋 User left conversation: ${conversationId}`);
  });

  // Listen for sending messages
  socket.on('sendMessage', (messageData) => {
    console.log('📩 Message received:', messageData);

    // Send to specific user rooms only to avoid duplicates
    const senderRoom = `user_${messageData.sender_type}_${messageData.sender_id}`;
    const receiverRoom = `user_${messageData.receiver_type}_${messageData.receiver_id}`;
    
    const messageWithTimestamp = {
      ...messageData,
      id: Date.now(),
      created_at: new Date().toISOString(),
    };
    
    // Send to sender (for confirmation)
    io.to(senderRoom).emit('receiveMessage', messageWithTimestamp);
    
    // Send to receiver
    io.to(receiverRoom).emit('receiveMessage', messageWithTimestamp);
  });

  socket.on('disconnect', () => {
    console.log('🔴 User disconnected:', socket.id);
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});

module.exports = { app, server, io };
