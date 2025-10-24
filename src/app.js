// eLaba-backend/src/app.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const http = require('http'); 
const { Server } = require('socket.io');
const path = require('path');

const customerRoutes = require('./routes/customerRoutes');
const adminRoutes = require('./routes/adminRoutes');
const shopRoutes = require('./routes/shopRoutes');
const serviceRoutes = require('./routes/serviceRoutes');
const bookingRoutes = require('./routes/bookingRoutes');
const deliveryRoutes = require('./routes/deliveryRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const messageRoutes = require('./routes/messageRoutes');
const notificationRoutes = require("./routes/notificationRoutes");
const superAdminRoutes = require('./routes/superAdminRoutes');
const otpRoutes = require('./routes/otpRoutes');
const imageRoutes = require('./routes/imageRoutes');


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

// Serve static files for uploaded images
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Routes
app.use('/api/customers', customerRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/shop', shopRoutes);
app.use('/api/service', serviceRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/delivery', deliveryRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/messages', messageRoutes);
app.use("/api/notifications", notificationRoutes);
app.use('/api/superadmin', superAdminRoutes);
app.use('/api/otp', otpRoutes);
app.use('/api/images', imageRoutes);

// Payment success page - temporarily disabled
// app.get('/payment/success', (req, res) => {
//   res.sendFile(path.join(__dirname, '../payment-success.html'));
// });
  

// Socket.IO events
io.on('connection', (socket) => {
  console.log('🟢 A user is online:', socket.id);

  // Join user to a room
  socket.on('join', (userData) => {
    const { userId, userType } = userData;
    const roomId = `user_${userType}_${userId}`;
    socket.join(roomId);
    console.log(`👤 User ${userId} (${userType}) joined room: ${roomId}`);
    // Also join role-based room for broadcast by role
    if (userType) {
      const roleRoom = `role_${userType}`;
      socket.join(roleRoom);
      console.log(`👥 User ${userId} joined role room: ${roleRoom}`);
    }
    // Persist user info for disconnect logging
    socket.userData = { userId, userType };
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

  socket.on('disconnect', (reason) => {
    console.log(`🔴 User disconnected: ${socket.id} (Reason: ${reason})`);
    if (socket.userData) {
      console.log(`👤 Disconnected user: ${socket.userData.userId} (${socket.userData.userType})`);
      
      // Optional: Notify other users in conversations that this user went offline
      // This could be used for showing online/offline status
      const userRoom = `user_${socket.userData.userType}_${socket.userData.userId}`;
      socket.broadcast.emit('userOffline', {
        userId: socket.userData.userId,
        userType: socket.userData.userType,
        timestamp: new Date().toISOString()
      });
    }
    
    // Clean up any remaining rooms
    socket.leaveAll();
  });
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
  console.log(`📱 Android emulator access: http://10.0.2.2:${PORT}`);
  console.log(`💻 Localhost access: http://localhost:${PORT}`);
});

module.exports = { app, server, io };
