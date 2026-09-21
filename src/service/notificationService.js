const admin = require('../config/firebase');
const db = require("../config/db");

function stringifyPushData(data) {
  return Object.fromEntries(
    Object.entries(data && typeof data === 'object' ? data : {}).map(([key, value]) => [
      key,
      value == null
        ? ''
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value),
    ])
  );
}

async function sendPushOnly({ title, message, deviceToken, data = {}, tag, chat = false }) {
  if (!deviceToken) return;

  const pushData = stringifyPushData({
    ...data,
    title,
    message,
    tag,
    isChat: chat ? '1' : '0',
  });

  const payload = chat
    ? {
        data: pushData,
        android: {
          priority: 'high',
        },
      }
    : {
        notification: { title, body: message },
        data: pushData,
        android: {
          notification: {
            icon: 'ic_notif_elaba',
            tag,
          },
        },
      };

  const sendPayload = {
    token: deviceToken,
    ...payload,
  };

  try {
    await admin.messaging().send(sendPayload);
    console.log('✅ Push sent to token');
    return true;
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
    return false;
  }
}

async function getDeviceTokensForAccount(accountId, accountType) {
  const [rows] = await db.query(
    `SELECT DISTINCT token FROM device_tokens WHERE account_id = ? AND account_type = ?`,
    [accountId, accountType]
  );

  return Array.isArray(rows)
    ? rows.map(row => row.token).filter(Boolean)
    : [];
}

async function sendPushToAccount({ accountId, accountType, title, message, data = {}, tag, chat = false }) {
  const tokens = await getDeviceTokensForAccount(accountId, accountType);
  if (!tokens.length) {
    return 0;
  }

  let sentCount = 0;
  for (const token of tokens) {
    const sent = await sendPushOnly({ title, message, deviceToken: token, data, tag, chat });
    if (sent) {
      sentCount++;
    } else {
      console.warn(`⚠️ Skipped invalid or failed token for ${accountType} ${accountId}`);
    }
  }
  return sentCount;
}

// Main notification function that saves to DB and sends push
// Returns the saved notification row for optional socket emission by callers
async function sendNotification({ accountId, accountType, bookingId, title, message, deviceToken, replaceExisting = false, existingTitles = [] }) {
  if (accountType === 'customer' && title?.trim().toLowerCase() === 'reschedule request submitted') {
    return { notificationId: null, savedNotification: null, skipped: true };
  }

  const duplicateKey = [
    String(accountType || ''),
    String(accountId || ''),
    String(bookingId ?? ''),
    String(title || ''),
    String(title || '').toLowerCase().includes('rejected') ? '' : String(message || '')
  ].join('|');

  const isRejectionNotification = String(title || '').toLowerCase().includes('rejected');

  const [duplicateRows] = await db.query(
    isRejectionNotification
      ? `SELECT notification_id
         FROM notifications
         WHERE account_type = ?
           AND account_id = ?
           AND COALESCE(booking_id, '') = COALESCE(?, '')
           AND LOWER(TRIM(title)) = LOWER(TRIM(?))
         ORDER BY created_at DESC, notification_id DESC LIMIT 1`
      : `SELECT notification_id
         FROM notifications
         WHERE account_type = ?
           AND account_id = ?
           AND COALESCE(booking_id, '') = COALESCE(?, '')
           AND LOWER(TRIM(title)) = LOWER(TRIM(?))
           AND LOWER(TRIM(message)) = LOWER(TRIM(?))
         ORDER BY created_at DESC, notification_id DESC LIMIT 1`,
    isRejectionNotification
      ? [accountType, accountId, bookingId ?? null, title || '']
      : [accountType, accountId, bookingId ?? null, title || '', message || '']
  );

  if (duplicateRows && duplicateRows[0]) {
    const existingNotificationId = duplicateRows[0].notification_id;
    await db.query(
      'UPDATE notifications SET created_at = CURRENT_TIMESTAMP, is_read = 0 WHERE notification_id = ?',
      [existingNotificationId]
    );

    const [freshRows] = await db.query('SELECT * FROM notifications WHERE notification_id = ? LIMIT 1', [existingNotificationId]);
    return { notificationId: existingNotificationId, savedNotification: freshRows?.[0] || null, duplicateKey };
  }

  // 1. Save to DB (in-app notification). Customer updates share one row per booking.
  let notificationId;
  if (accountType === 'customer' && bookingId) {
    const [existingRows] = await db.query(
      `SELECT notification_id FROM notifications
       WHERE account_type = ? AND account_id = ? AND booking_id = ?
       ORDER BY created_at DESC, notification_id DESC LIMIT 1`,
      [accountType, accountId, bookingId]
    );
    notificationId = existingRows?.[0]?.notification_id;

    if (notificationId) {
      await db.query(
        'UPDATE notifications SET title = ?, message = ?, created_at = CURRENT_TIMESTAMP, is_read = 0 WHERE notification_id = ?',
        [title, message, notificationId]
      );
      await db.query(
        `DELETE FROM notifications
         WHERE account_type = ? AND account_id = ? AND booking_id = ? AND notification_id <> ?`,
        [accountType, accountId, bookingId, notificationId]
      );
    }
  } else if (replaceExisting && bookingId && existingTitles.length) {
    const placeholders = existingTitles.map(() => '?').join(', ');
    const [existingRows] = await db.query(
      `SELECT notification_id FROM notifications
       WHERE account_type = ? AND account_id = ? AND booking_id = ? AND title IN (${placeholders})
       ORDER BY created_at DESC, notification_id DESC LIMIT 1`,
      [accountType, accountId, bookingId, ...existingTitles]
    );
    notificationId = existingRows?.[0]?.notification_id;

    if (notificationId) {
      await db.query(
        'UPDATE notifications SET title = ?, message = ?, created_at = CURRENT_TIMESTAMP, is_read = 0 WHERE notification_id = ?',
        [title, message, notificationId]
      );
      await db.query(
        `DELETE FROM notifications
         WHERE account_type = ? AND account_id = ? AND booking_id = ? AND title IN (${placeholders}) AND notification_id <> ?`,
        [accountType, accountId, bookingId, ...existingTitles, notificationId]
      );
    }
  }

  if (!notificationId) {
    const [result] = await db.query(
      "INSERT INTO notifications (account_type, account_id, booking_id, title, message) VALUES (?, ?, ?, ?, ?)",
      [accountType, accountId, bookingId, title, message]
    );
    notificationId = result?.insertId;
  }

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
  const targetTokens = deviceToken
    ? [deviceToken]
    : accountId && accountType
      ? await getDeviceTokensForAccount(accountId, accountType)
      : [];

  if (targetTokens.length) {
    for (const token of targetTokens) {
      const payload = {
        notification: {
          title,
          body: message,
        },
        data: {
          title,
          message,
          bookingId: bookingId ? bookingId.toString() : "",
          accountType,
          notificationId: notificationId ? notificationId.toString() : '',
        },
        android: {
          notification: {
            icon: "ic_notif_elaba",
            //color: "#2d79d1",
          },
        },
      };

      try {
        await admin.messaging().send({ token, ...payload });
        console.log(`✅ Push sent to ${accountType} ${accountId}`);
      } catch (err) {
        console.error("❌ Error sending push:", err);

        // If token is invalid, remove it from database
        if (err.errorInfo &&
            (err.errorInfo.code === 'messaging/registration-token-not-registered' ||
             err.errorInfo.code === 'messaging/invalid-registration-token')) {
          try {
            await db.query('DELETE FROM device_tokens WHERE token = ?', [token]);
            console.log(`🗑️ Removed invalid token from database: ${token.substring(0, 20)}...`);
          } catch (deleteErr) {
            console.error('❌ Failed to delete invalid token:', deleteErr);
          }
        }
      }
    }
  }

  return { notificationId, savedNotification };
}

module.exports = { sendPushOnly, sendNotification, sendPushToAccount };
