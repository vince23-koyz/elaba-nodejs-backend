const db = require("../config/db");
const admin = require("../config/firebase");
const { sendNotification } = require("../service/notificationService");

// Import io from app.js
let io;
const getIO = () => {
  if (!io) {
    const { io: socketIO } = require('../app');
    io = socketIO;
  }
  return io;
};

// ✅ Save device token (ginagamit ng app pag-login)
// Ensure one row per unique token to avoid duplicates even if client retries
exports.updateDeviceToken = async (req, res) => {
  const { accountId, accountType, shopId, token } = req.body;

  if (!accountId || !accountType || !token) {
    return res.status(400).json({ success: false, message: "Missing required fields" });
  }

  try {
    // Remove any duplicate rows for the same token first (idempotent behavior)
    await db.query('DELETE FROM device_tokens WHERE token = ?', [token]);

    // Insert a single fresh row for this token
    await db.query(
      `INSERT INTO device_tokens (account_id, account_type, shop_id, token, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, NOW(), NOW())`,
      [accountId, accountType, shopId || null, token]
    );

    res.json({ success: true, message: "Device token saved (deduped) and activated" });
  } catch (err) {
    console.error("❌ Error saving token:", err);
    res.status(500).json({ success: false, message: "Database error" });
  }
};

// ✅ Deactivate device token (ginagamit ng app pag-logout)
exports.deactivateDeviceToken = async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ success: false, message: "Token required" });

  try {
    await db.query(`
      UPDATE device_tokens 
      SET is_active = 0, updated_at = NOW()
      WHERE token = ?
    `, [token]);

    res.json({ success: true, message: "Device token deactivated" });
  } catch (err) {
    console.error("❌ Error deactivating token:", err);
    res.status(500).json({ success: false, message: "Failed to deactivate token" });
  }
};

// ✅ Permanently delete a device token (used on logout)
exports.deleteDeviceToken = async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ success: false, message: 'Token required' });

  try {
    const [result] = await db.query('DELETE FROM device_tokens WHERE token = ?', [token]);
    res.json({ success: true, message: 'Device token deleted', affected: result.affectedRows });
  } catch (err) {
    console.error('❌ Error deleting token:', err);
    res.status(500).json({ success: false, message: 'Failed to delete token' });
  }
};

// ✅ Get all in-app notifications
exports.getNotifications = async (req, res) => {
  const { accountId, accountType } = req.query;

  try {
    const [rows] = await db.query(
      `SELECT n.*
       FROM notifications n
       LEFT JOIN booking b ON b.booking_id = n.booking_id
       WHERE n.account_id = ?
         AND n.account_type = ?
         AND NOT (n.account_type = 'customer' AND LOWER(TRIM(n.title)) = 'reschedule request submitted')
         AND NOT (
           n.account_type = 'customer'
           AND LOWER(TRIM(n.title)) = 'booking declined'
           AND (
             LOWER(COALESCE(b.status, '')) = 'cancelled'
             OR EXISTS (
               SELECT 1
               FROM booking_reschedule br
               WHERE br.booking_id = n.booking_id
             )
           )
         )
       ORDER BY n.created_at DESC`,
      [accountId, accountType]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
};

// ✅ Mark single notification as read
exports.markNotificationAsRead = async (req, res) => {
  const { notificationId } = req.params;

  if (!notificationId) {
    return res.status(400).json({ error: "Notification ID is required" });
  }

  try {
    // Update notification as read
    const [result] = await db.query(
      "UPDATE notifications SET is_read = 1 WHERE notification_id = ?",
      [notificationId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Notification not found" });
    }

    // Get updated notification to return
    const [updatedNotification] = await db.query(
      "SELECT * FROM notifications WHERE notification_id = ?",
      [notificationId]
    );

    res.json({ 
      success: true, 
      message: "Notification marked as read",
      notification: updatedNotification[0]
    });
  } catch (err) {
    console.error("❌ Error marking notification as read:", err);
    res.status(500).json({ error: "Failed to mark notification as read" });
  }
};

// ✅ Mark all notifications as read for a user
exports.markAllNotificationsAsRead = async (req, res) => {
  const { accountId, accountType } = req.body;

  if (!accountId || !accountType) {
    return res.status(400).json({ error: "Account ID and account type are required" });
  }

  try {
    const [result] = await db.query(
      "UPDATE notifications SET is_read = 1 WHERE account_id = ? AND account_type = ? AND is_read = 0",
      [accountId, accountType]
    );

    res.json({ 
      success: true, 
      message: `Marked ${result.affectedRows} notifications as read`
    });
  } catch (err) {
    console.error("❌ Error marking all notifications as read:", err);
    res.status(500).json({ error: "Failed to mark all notifications as read" });
  }
};

// ✅ Send notification to customer (save to DB + push)
exports.sendNotificationToCustomer = async (req, res) => {
  const { customerId, bookingId, title, message } = req.body;

  if (!customerId || !bookingId || !title || !message) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (title.trim().toLowerCase() === 'reschedule request submitted') {
    return res.status(200).json({
      success: true,
      skipped: true,
      message: 'Submitted reschedule notifications are disabled',
    });
  }

  try {
    // 1️⃣ Save notification sa DB (para sa customer)
    const [result] = await db.query(
      `INSERT INTO notifications (account_type, account_id, booking_id, title, message) 
       VALUES (?, ?, ?, ?, ?)`,
      ["customer", customerId, bookingId, title, message]
    );

    const notificationId = result.insertId;

    // Get the saved notification to emit via socket
    const [savedNotification] = await db.query(
      "SELECT * FROM notifications WHERE notification_id = ?",
      [notificationId]
    );

    // Emit real-time notification to the customer
    const io = getIO();
    if (io && savedNotification.length > 0) {
      const userRoom = `user_customer_${customerId}`;
      io.to(userRoom).emit('newNotification', savedNotification[0]);
      console.log(`📡 Emitted new notification to customer room: ${userRoom}`);
    }

    // 2️⃣ Kunin tokens ng customer
    const [tokenRows] = await db.query(
      `SELECT token 
         FROM device_tokens 
        WHERE account_id = ? AND account_type = 'customer' AND is_active = 1`,
      [customerId]
    );

    let pushSent = 0;

    if (tokenRows.length > 0) {
      // 3️⃣ Send push notification
      for (const row of tokenRows) {
        try {
          await admin.messaging().send({
            token: row.token,
            notification: {
              title,
              body: message,                         
            },
            data: {
              bookingId: bookingId.toString(),
              notificationId: notificationId.toString(),
            },
          });
          pushSent++;
        } catch (pushErr) {
          console.error(`❌ Failed push to token ${row.token}:`, pushErr);
          
          // If token is invalid, remove it from database
          if (pushErr.errorInfo && 
              (pushErr.errorInfo.code === 'messaging/registration-token-not-registered' ||
               pushErr.errorInfo.code === 'messaging/invalid-registration-token')) {
            try {
              await db.query(
                'DELETE FROM device_tokens WHERE token = ?',
                [row.token]
              );
              console.log(`🗑️ Removed invalid token from database: ${row.token.substring(0, 20)}...`);
            } catch (deleteErr) {
              console.error('❌ Failed to delete invalid token:', deleteErr);
            }
          }
        }
      }
    }

    res.json({
      success: true,
      notification_id: notificationId,
      push_sent: pushSent,
      message: `Notification saved and ${pushSent} push sent to customer`,
    });

  } catch (err) {
    console.error("❌ Error in sendNotificationToCustomer:", err);
    res.status(500).json({ error: "Failed to send notification", details: err.message });
  }
};

// ✅ Send notification to shop's admins (save to DB + push)
exports.sendNotificationToShop = async (req, res) => {
  const { shopId, bookingId, title, message } = req.body;

  if (!shopId || !bookingId || !title || !message) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    // 🔎 Kunin admin_id ng shop
    const [shopRows] = await db.query(
      "SELECT admin_id FROM shop WHERE shop_id = ?",
      [shopId]
    );

    if (shopRows.length === 0) {
      return res.status(404).json({ error: "Shop not found" });
    }

    const adminId = shopRows[0].admin_id;

    // 1️⃣ Save notification sa DB (para sa admin)
    const [result] = await db.query(
      `INSERT INTO notifications (account_type, account_id, booking_id, title, message) 
       VALUES (?, ?, ?, ?, ?)`,
      ["admin", adminId, bookingId, title, message]
    );

    const notificationId = result.insertId;

    // Get the saved notification to emit via socket
    const [savedNotification] = await db.query(
      "SELECT * FROM notifications WHERE notification_id = ?",
      [notificationId]
    );

    // Emit real-time notification to the admin
    const io = getIO();
    if (io && savedNotification.length > 0) {
      const userRoom = `user_admin_${adminId}`;
      io.to(userRoom).emit('newNotification', savedNotification[0]);
      console.log(`📡 Emitted new notification to room: ${userRoom}`);
    }

    // 2️⃣ Kunin tokens ng admins ng shop
    const [tokenRows] = await db.query(
      `SELECT token 
         FROM device_tokens 
        WHERE account_id = ? AND account_type = 'admin' AND is_active = 1`,
      [adminId]
    );

    let pushSent = 0;

    if (tokenRows.length > 0) {
      // 3️⃣ Send push notification
      for (const row of tokenRows) {
        try {
          await admin.messaging().send({
            token: row.token,
            notification: {
              title,
              body: message,                         
            },
            data: {
              bookingId: bookingId.toString(),
              notificationId: notificationId.toString(),
            },
          });
          pushSent++;
        } catch (pushErr) {
          console.error(`❌ Failed push to token ${row.token}:`, pushErr);
          
          // If token is invalid, remove it from database
          if (pushErr.errorInfo && 
              (pushErr.errorInfo.code === 'messaging/registration-token-not-registered' ||
               pushErr.errorInfo.code === 'messaging/invalid-registration-token')) {
            try {
              await db.query(
                'DELETE FROM device_tokens WHERE token = ?',
                [row.token]
              );
              console.log(`🗑️ Removed invalid token from database: ${row.token.substring(0, 20)}...`);
            } catch (deleteErr) {
              console.error('❌ Failed to delete invalid token:', deleteErr);
            }
          }
        }
      }
    }

    res.json({
      success: true,
      notification_id: notificationId,
      push_sent: pushSent,
      message: `Notification saved and ${pushSent} push sent`,
    });

  } catch (err) {
    console.error("❌ Error in sendNotificationToShop:", err);
    res.status(500).json({ error: "Failed to send notification", details: err.message });
  }
};

// ✅ Example trigger for testing push
exports.testNotif = async (req, res) => {
  const { accountId, accountType, bookingId } = req.body;

  try {
    // Kunin muna yung token mula DB
    const [rows] = await db.query(
      "SELECT token FROM device_tokens WHERE account_id = ? AND account_type = ? AND is_active = 1 LIMIT 1",
      [accountId, accountType]
    );

    if (!rows.length) {
      return res.status(404).json({ error: "No device token found" });
    }

    const deviceToken = rows[0].token;

    await sendNotification({
      accountId,
      accountType,
      bookingId,
      title: "Test Notification",
      message: "This is a test notification",
      deviceToken,
    });

    res.json({ success: true });
  } catch (err) {
    console.error("❌ Error testNotif:", err);
    res.status(500).json({ error: "Failed to send notification" });
  }
};

//for testing
const { sendPushOnly } = require("../service/notificationService");

exports.testPushWithoutDB = async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "No token provided" });

  try {
    await sendPushOnly({
      title: "Test Push",
      message: "This is a test push without saving to DB",
      deviceToken: token,
    });

    res.json({ success: true, message: "Push sent without DB" });
  } catch (err) {
    console.error("❌ Test push error backend:", err);
    res.status(500).json({ error: "Failed to send push" });
  }
};