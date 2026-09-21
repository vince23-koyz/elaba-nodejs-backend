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
const transactionRoutes = require('./routes/transactionRoutes');
const messageRoutes = require('./routes/messageRoutes');
const notificationRoutes = require("./routes/notificationRoutes");
const { sendPushToAccount } = require('./service/notificationService');
const superAdminRoutes = require('./routes/superAdminRoutes');
const otpRoutes = require('./routes/otpRoutes');
const imageRoutes = require('./routes/imageRoutes');
const paymentController = require('./controllers/paymentController');

async function getSenderDisplayName(senderType, senderId) {
  if (!senderType || !senderId) {
    return null;
  }

  try {
    if (senderType === 'customer') {
      const [rows] = await db.query(
        'SELECT first_name, last_name FROM customer WHERE customer_id = ? LIMIT 1',
        [senderId]
      );
      if (Array.isArray(rows) && rows[0]) {
        const name = `${rows[0].first_name || ''} ${rows[0].last_name || ''}`.trim();
        return name || null;
      }
    }

    if (senderType === 'admin') {
      const [rows] = await db.query(
        'SELECT first_name, last_name FROM admin WHERE admin_id = ? LIMIT 1',
        [senderId]
      );
      if (Array.isArray(rows) && rows[0]) {
        const name = `${rows[0].first_name || ''} ${rows[0].last_name || ''}`.trim();
        return name || null;
      }
    }
  } catch (err) {
    console.warn('⚠️ Failed to resolve sender display name:', err?.message || err);
  }

  return null;
}

async function getShopName(shopId) {
  if (!shopId) {
    return null;
  }

  try {
    const [rows] = await db.query(
      'SELECT name FROM shop WHERE shop_id = ? LIMIT 1',
      [shopId]
    );
    if (Array.isArray(rows) && rows[0]) {
      return rows[0].name || null;
    }
  } catch (err) {
    console.warn('⚠️ Failed to resolve shop name:', err?.message || err);
  }

  return null;
}

async function getShopLogo(shopId) {
  if (!shopId) return null;
  try {
    const [rows] = await db.query(
      'SELECT logo FROM shop WHERE shop_id = ? LIMIT 1',
      [shopId]
    );
    if (Array.isArray(rows) && rows[0]) {
      let logo = rows[0].logo || null;
      if (logo) {
        // If logo is a relative path (e.g. /uploads/...), prefix with PUBLIC_BASE_URL
        const isAbsolute = /^https?:\/\//.test(logo);
        if (!isAbsolute) {
          const base = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
          if (logo.startsWith('/')) {
            logo = `${base}${logo}`;
          } else {
            logo = `${base}/${logo}`;
          }
        }
      }
      return logo;
    }
  } catch (err) {
    console.warn('⚠️ Failed to resolve shop logo:', err?.message || err);
  }
  return null;
}


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
app.use(cors({
  origin: (origin, callback) => {
    const allowedOrigins = [
      "http://localhost:3000",
      "http://localhost:3001",
      "http://127.0.0.1:3000",
      "http://127.0.0.1:3001",
      "http://192.168.8.130:3000",
      "http://72.61.210.160",
      "http://72.61.210.160:3000",
    ];

    const isLanOrigin = typeof origin === "string" && /^http:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+)(?::\d+)?$/.test(origin);

    if (!origin || allowedOrigins.includes(origin) || isLanOrigin) {
      callback(null, true);
      return;
    }

    callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
  optionsSuccessStatus: 204
}));
// PayMongo signatures are calculated over the exact raw request body.
app.post('/api/payments/webhook', bodyParser.raw({ type: 'application/json' }), paymentController.handlePayMongoWebhook);
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
app.use('/api/transactions', transactionRoutes);
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
  socket.on('sendMessage', async (messageData) => {
    console.log('📩 Message received:', messageData);

    const senderRoom = `user_${messageData.sender_type}_${messageData.sender_id}`;
    const receiverRoom = `user_${messageData.receiver_type}_${messageData.receiver_id}`;
    const customerId = messageData.sender_type === 'customer' ? messageData.sender_id : messageData.receiver_id;
    const adminId = messageData.sender_type === 'admin' ? messageData.sender_id : messageData.receiver_id;
    const conversationId = `shop_${messageData.shop_id}_customer_${customerId}_admin_${adminId}`;

    const messageWithTimestamp = {
      ...messageData,
      id: Date.now(),
      created_at: new Date().toISOString(),
    };

    io.to(senderRoom).emit('receiveMessage', messageWithTimestamp);
    io.to(receiverRoom).emit('receiveMessage', messageWithTimestamp);
    io.to(conversationId).emit('receiveMessage', messageWithTimestamp);

    try {
      const senderName = await getSenderDisplayName(messageData.sender_type, messageData.sender_id);
      const shopName = await getShopName(messageData.shop_id);
      const shopLogo = await getShopLogo(messageData.shop_id);
      const messageText = messageData.message_text;

      await sendPushToAccount({
        accountId: messageData.receiver_id,
        accountType: messageData.receiver_type,
        title: 'New message',
        message: messageText,
        data: {
          sender_type: messageData.sender_type,
          sender_id: String(messageData.sender_id),
          sender_name: senderName || '',
          receiver_type: String(messageData.receiver_type),
          receiver_id: String(messageData.receiver_id),
          shop_id: String(messageData.shop_id),
          shop_name: shopName || '',
          shop_image_url: shopLogo || '',
          conversationId,
          // include message id so native notifications can dedupe and remove read messages
          message_id: String(messageWithTimestamp.id),
        },
        tag: `${messageData.receiver_type}_${messageData.receiver_id}_${conversationId}`,
        chat: true,
      });
    } catch (pushErr) {
      console.warn('⚠️ Failed to send push notification for message:', pushErr?.message || pushErr);
    }
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
