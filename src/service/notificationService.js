const admin = require('../config/firebase');
const db = require("../config/db");

async function sendPushOnly({ title, message, deviceToken }) {
  if (!deviceToken) return;

  const payload = {
    notification: { title, body: message },
    data: {}, 
  };

  try {
    await admin.messaging().send({
      token: deviceToken,
      ...payload,
    });
    console.log('✅ Push sent!');
  } catch (err) {
    console.error('❌ Error sending push:', err);
    
    // If token is invalid, remove it from database
    if (err.errorInfo && 
        (err.errorInfo.code === 'messaging/registration-token-not-registered' ||
         err.errorInfo.code === 'messaging/invalid-registration-token')) {
      try {
        await db.query('DELETE FROM device_tokens WHERE token = ?', [deviceToken]);
        console.log(`🗑️ Removed invalid token from database: ${deviceToken.substring(0, 20)}...`);
      } catch (deleteErr) {
        console.error('❌ Failed to delete invalid token:', deleteErr);
      }
    }
  }
}

// Main notification function that saves to DB and sends push
// Returns the saved notification row for optional socket emission by callers
async function sendNotification({ accountId, accountType, bookingId, title, message, deviceToken }) {
  // 1. Save to DB (in-app notification)
  const [result] = await db.query(
    "INSERT INTO notifications (account_type, account_id, booking_id, title, message) VALUES (?, ?, ?, ?, ?)",
    [accountType, accountId, bookingId, title, message]
  );

  const notificationId = result?.insertId;
  let savedNotification = null;
  try {
    if (notificationId) {
      const [rows] = await db.query(
        'SELECT * FROM notifications WHERE notification_id = ? LIMIT 1',
        [notificationId]
      );
      savedNotification = rows && rows[0] ? rows[0] : null;
    }
  } catch (e) {
    // Not critical if we can't refetch; push will still be sent
    console.warn('⚠️ Failed to re-fetch saved notification:', e?.message || e);
  }

  // 2. Push notification
  if (deviceToken) {
    const payload = {
      notification: {
        title,
        body: message,
      },
      android: {
        notification: {
          icon: "ic_stat_elaba",
          //color: "#2d79d1",
        },
      },
      data: {
        bookingId: bookingId ? bookingId.toString() : "",
        accountType,
        notificationId: notificationId ? notificationId.toString() : '',
      },
    };

    try {
      await admin.messaging().send({ token: deviceToken, ...payload });
      console.log(`✅ Push sent to ${accountType} ${accountId}`);
    } catch (err) {
      console.error("❌ Error sending push:", err);
      
      // If token is invalid, remove it from database
      if (err.errorInfo && 
          (err.errorInfo.code === 'messaging/registration-token-not-registered' ||
           err.errorInfo.code === 'messaging/invalid-registration-token')) {
        try {
          await db.query('DELETE FROM device_tokens WHERE token = ?', [deviceToken]);
          console.log(`🗑️ Removed invalid token from database: ${deviceToken.substring(0, 20)}...`);
        } catch (deleteErr) {
          console.error('❌ Failed to delete invalid token:', deleteErr);
        }
      }
    }
  }

  return { notificationId, savedNotification };
}

module.exports = { sendPushOnly, sendNotification };
