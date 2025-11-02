// eLaba-backend/src/app.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const http = require('http'); 
const { Server } = require('socket.io');
const path = require('path');
const db = require('./config/db');

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

// Make io available to route handlers via app.get('io') to avoid circular requires
app.set('io', io);

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
// Track presence counts per user to set is_active online/offline accurately
const userPresence = new Map(); // key: `${userType}:${userId}` -> count

io.on('connection', (socket) => {
  console.log('🟢 A user is online:', socket.id);

  // Join user to a room
  socket.on('join', async (userData) => {
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

    // Update presence counter and mark online in DB on first connection
    try {
      const key = `${userType}:${userId}`;
      const current = userPresence.get(key) || 0;
      userPresence.set(key, current + 1);
      if (current === 0) {
        await db.query(
          'UPDATE device_tokens SET is_active = 1, updated_at = NOW() WHERE account_id = ? AND account_type = ?',
          [userId, userType]
        );
        socket.broadcast.emit('userOnline', { userId, userType, timestamp: new Date().toISOString() });
      }
    } catch (e) {
      console.warn('⚠️ Failed to set presence online:', e?.message || e);
    }
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

  socket.on('disconnect', async (reason) => {
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

      // Update presence counter and mark offline in DB when count reaches zero
      try {
        const key = `${socket.userData.userType}:${socket.userData.userId}`;
        const current = userPresence.get(key) || 0;
        const next = Math.max(0, current - 1);
        if (next === 0) {
          userPresence.delete(key);
          await db.query(
            'UPDATE device_tokens SET is_active = 0, updated_at = NOW() WHERE account_id = ? AND account_type = ?',
            [socket.userData.userId, socket.userData.userType]
          );
        } else {
          userPresence.set(key, next);
        }
      } catch (e) {
        console.warn('⚠️ Failed to set presence offline:', e?.message || e);
      }
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
