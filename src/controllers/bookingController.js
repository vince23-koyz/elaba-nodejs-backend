const db = require('../config/db'); 
const { sendNotification } = require('../service/notificationService');
const paymongoService = require('../service/paymongoService');

// Helper: get admin_id and device token for a given shop_id
async function getAdminInfoByShop(shopId) {
  try {
    const [rows] = await db.query(`
      SELECT s.admin_id, dt.token as device_token
      FROM shop s
      LEFT JOIN device_tokens dt ON dt.account_id = s.admin_id AND dt.account_type = 'admin'
      WHERE s.shop_id = ?
      LIMIT 1
    `, [shopId]);
    if (rows && rows.length > 0) return rows[0];
    return null;
  } catch (e) {
    console.error('Error fetching admin_id by shop:', e);
    return null;
  }
}

// Helper: emit booking event to the admin room of the shop
async function emitBookingEvent(io, shopId, eventName, payload = {}) {
  try {
    const adminInfo = await getAdminInfoByShop(shopId);
    if (!adminInfo || !adminInfo.admin_id) return;
    const room = `user_admin_${adminInfo.admin_id}`;
    if (io && io.to) {
      io.to(room).emit(eventName, { shopId, ...payload });
    }
  } catch (e) {
    console.error('Error emitting booking event:', e);
  }
}

async function processCustomerBookingRefund({ bookingId, customerId, reason = null, notes, requireCancelled = false, processWithPayMongo = false }) {
  const connection = await db.getConnection();
  let refundId;
  let payment;

  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(`
      SELECT b.booking_id, b.customer_id, b.status AS booking_status,
             p.payment_id, p.payment_method, p.amount, p.status AS payment_status,
             p.paymongo_payment_id
      FROM booking b
      LEFT JOIN payment p ON p.booking_id = b.booking_id
      WHERE b.booking_id = ?
      LIMIT 1
      FOR UPDATE
    `, [bookingId]);

    if (!rows.length) {
      await connection.rollback();
      return { success: false, code: 404, message: 'Booking not found' };
    }
    payment = rows[0];
    if (customerId != null && Number(payment.customer_id) !== Number(customerId)) {
      await connection.rollback();
      return { success: false, code: 403, message: 'You are not authorized to cancel this booking' };
    }
    if (requireCancelled && String(payment.booking_status || '').toLowerCase() !== 'cancelled') {
      await connection.rollback();
      return { success: false, code: 400, message: 'Booking must be cancelled before requesting a refund' };
    }

    const isGCash = String(payment.payment_method || '').toLowerCase() === 'gcash';
    const isPaid = ['paid', 'success', 'succeeded', 'completed'].includes(String(payment.payment_status || '').toLowerCase());
    if (!isGCash || !isPaid) {
      await connection.commit();
      return { success: true, refund: null };
    }
    if (!payment.paymongo_payment_id) {
      await connection.rollback();
      return { success: false, code: 409, message: 'This GCash payment is missing its PayMongo payment ID' };
    }
    const amount = Number(payment.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      await connection.rollback();
      return { success: false, code: 400, message: 'Payment has an invalid refund amount' };
    }

    const [existing] = await connection.query(`
      SELECT refund_id, paymongo_refund_id, amount, reason, notes, status
      FROM refund
      WHERE payment_id = ? AND booking_id = ?
        AND LOWER(COALESCE(status, '')) IN ('pending', 'processing', 'succeeded')
      ORDER BY refund_id DESC
      LIMIT 1
      FOR UPDATE
    `, [payment.payment_id, bookingId]);
    if (existing.length) {
      const existingRefund = existing[0];
      if (!processWithPayMongo || ['processing', 'succeeded'].includes(String(existingRefund.status || '').toLowerCase())) {
        await connection.commit();
        return { success: true, refund: existingRefund, duplicate: true };
      }
      refundId = existingRefund.refund_id;
      reason = processWithPayMongo ? reason : (existingRefund.reason || reason);
      notes = processWithPayMongo ? notes : (existingRefund.notes || notes);
      if (processWithPayMongo) {
        await connection.query(
          'UPDATE refund SET reason = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE refund_id = ?',
          [reason, notes || null, refundId]
        );
      }
    } else {
      const [insertResult] = await connection.query(`
        INSERT INTO refund (payment_id, booking_id, amount, reason, notes, status)
        VALUES (?, ?, ?, ?, ?, 'pending')
      `, [payment.payment_id, bookingId, amount, reason, notes || null]);
      refundId = insertResult.insertId;
    }
    await connection.commit();
  } catch (error) {
    try { await connection.rollback(); } catch (_) { /* rollback best effort */ }
    console.error('Refund record transaction error:', error);
    return { success: false, code: 500, message: 'Unable to prepare refund' };
  } finally {
    connection.release();
  }

  if (!processWithPayMongo) {
    return {
      success: true,
      code: 201,
      message: 'Refund request created and is pending processing',
      refund: {
        refund_id: refundId,
        paymongo_refund_id: null,
        amount: Number(payment.amount),
        reason,
        notes: notes || null,
        status: 'pending'
      }
    };
  }

  await db.query(
    'UPDATE refund SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE refund_id = ? AND LOWER(COALESCE(status, ?)) = ?',
    ['processing', refundId, 'pending', 'pending']
  );
  const resolvedPaymentId = await paymongoService.resolvePaymentId(payment.paymongo_payment_id);
  if (!resolvedPaymentId) {
    await db.query('UPDATE refund SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE refund_id = ?', ['failed', refundId]);
    return { success: false, code: 409, message: 'PayMongo payment ID is still unavailable. Wait for payment confirmation and retry the refund.' };
  }
  const providerResult = await paymongoService.createRefund({
    paymentId: resolvedPaymentId,
    amount: payment.amount,
    reason,
    notes
  });
  const providerRefund = providerResult.success ? providerResult.refund : null;
  const refundStatus = providerRefund?.attributes?.status || 'failed';
  await db.query(
    'UPDATE refund SET paymongo_refund_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE refund_id = ?',
    [providerRefund?.id || null, refundStatus, refundId]
  );

  return {
    success: providerResult.success,
    code: providerResult.success ? 200 : 502,
    message: providerResult.success ? undefined : providerResult.error,
    refund: {
      refund_id: refundId,
      paymongo_refund_id: providerRefund?.id || null,
      amount: Number(payment.amount),
      status: refundStatus
    }
  };
}

exports.processBookingRefund = processCustomerBookingRefund;

// CREATE Booking
exports.createBooking = async (req, res) => {
  const { booking_type, booking_date, pickup_date, status, total_amount, shop_id, service_id, customer_id } = req.body;

  // Debug log
  console.log('Create Booking:', req.body);

  // Determine which date field is provided
  const isPickupBooking = (booking_type || '').toLowerCase() === 'pick up';
  const dateField = isPickupBooking ? pickup_date : booking_date;

  // Validate required fields with detailed error messages
  if (!booking_type) {
    return res.status(400).json({ message: 'booking_type is required' });
  }
  if (!dateField) {
    const missingField = isPickupBooking ? 'pickup_date' : 'booking_date';
    return res.status(400).json({ message: `${missingField} is required` });
  }
  if (!status) {
    return res.status(400).json({ message: 'status is required' });
  }
  if (!total_amount && total_amount !== 0) {
    return res.status(400).json({ message: 'total_amount is required' });
  }
  if (!shop_id) {
    return res.status(400).json({ message: 'shop_id is required' });
  }
  if (!service_id) {
    return res.status(400).json({ message: 'service_id is required' });
  }
  if (!customer_id) {
    return res.status(400).json({ message: 'customer_id is required' });
  }

  try {
    let sql, params;

    if (isPickupBooking) {
      // Pickup bookings have no walk-in booking date.
      sql = `INSERT INTO booking (booking_type, booking_date, pickup_date, status, total_amount, shop_id, service_id, customer_id) 
                 VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`;
      params = [booking_type, pickup_date, status, total_amount, shop_id, service_id, customer_id];
    } else {
      // For walk-in: only populate booking_date, NOT pickup_date
      sql = `INSERT INTO booking (booking_type, booking_date, status, total_amount, shop_id, service_id, customer_id) 
                 VALUES (?, ?, ?, ?, ?, ?, ?)`;
      params = [booking_type, booking_date, status, total_amount, shop_id, service_id, customer_id];
    }

    const [result] = await db.query(sql, params);

    // Emit socket event for real-time updates (admin + superadmin)
    const io = req.app.get('io');
    emitBookingEvent(io, shop_id, 'bookingCreated', {
      bookingId: result.insertId,
      status,
    });
    if (io && io.to) {
      io.to('role_superadmin').emit('bookingCreated', {
        shopId: shop_id,
        bookingId: result.insertId,
        status,
        at: new Date().toISOString(),
      });
    }

    // Send Firebase notification to admin
    try {
      const adminInfo = await getAdminInfoByShop(shop_id);
      if (adminInfo && adminInfo.admin_id) {
        // Fetch customer name and service name
        let customerName = '';
        let serviceName = '';
        try {
          const [bookingRows] = await db.query(`
            SELECT c.first_name, c.last_name, srv.offers AS service_name
            FROM booking b
            JOIN customer c ON b.customer_id = c.customer_id
            LEFT JOIN services srv ON b.service_id = srv.service_id
            WHERE b.booking_id = ?
            LIMIT 1
          `, [result.insertId]);
          if (bookingRows && bookingRows[0]) {
            customerName = `${bookingRows[0].first_name} ${bookingRows[0].last_name}`.trim();
            serviceName = bookingRows[0].service_name || '';
          }
        } catch (e) { customerName = ''; serviceName = ''; }

        const customerDisplay = customerName || 'A customer';
        const message = `A new service booking has just been received from ${customerDisplay}! Please check the details and confirm the booking to begin processing.`;

        const { savedNotification } = await sendNotification({
          accountId: adminInfo.admin_id,
          accountType: 'admin',
          bookingId: result.insertId,
          title: 'New Service Booking',
          message,
          deviceToken: adminInfo.device_token || undefined,
        });

        // Emit real-time notification to the admin room
        const userRoom = `user_admin_${adminInfo.admin_id}`;
        if (io && savedNotification) {
          io.to(userRoom).emit('newNotification', savedNotification);
        }
      }
    } catch (notifErr) {
      console.error('Error sending new booking notification:', notifErr);
    }

    res.status(201).json({
      message: 'Booking created successfully',
      booking_id: result.insertId
    });
  } catch (err) {
    console.error('Booking DB Error:', err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

// CREATE Payment (linked to booking)
exports.createPayment = async (req, res) => {
  const { booking_id, customer_id, shop_id, service_id, payment_method, status } = req.body;

  if (!booking_id || !customer_id || !shop_id || !service_id || !payment_method || !status) {
    return res.status(400).json({ message: "All fields are required" });
  }

  try {
    const sql = `INSERT INTO payment 
      (booking_id, customer_id, shop_id, service_id, payment_method, status, date) 
      VALUES (?, ?, ?, ?, ?, ?, NOW())`;

    const [result] = await db.query(sql, [booking_id, customer_id, shop_id, service_id, payment_method, status]);

    res.status(201).json({
      message: "Payment created successfully",
      payment_id: result.insertId,
    });
  } catch (err) {
    console.error("Payment DB Error:", err);
    res.status(500).json({ message: "Database error", error: err.message });
  }
};

// GET ALL Bookings (with payment info and delivery info for pickup bookings)
exports.getBookings = async (req, res) => {
  const { shop_id, customer_id, status } = req.query; // Optional filters
  
  try {
    let sql = `SELECT b.booking_id, b.booking_type, 
       CASE 
         WHEN b.booking_type LIKE '%pick up%' COLLATE utf8mb4_general_ci THEN b.pickup_date
         ELSE b.booking_date
       END AS service_date,
      b.booking_date, b.pickup_date, b.created_at, b.status AS booking_status, b.total_amount, 
       b.shop_id, b.customer_id, s.name AS shop_name, c.first_name AS customer_first_name, c.last_name AS customer_last_name,
       p.payment_id, p.payment_method, p.status AS payment_status, p.date,
      r.refund_id, r.amount AS refund_amount, r.status AS refund_status,
       b.service_id, srv.offers AS service_name,
      d.delivery_id, d.pickup_address, d.delivery_address, d.delivery_time, d.status AS delivery_status
     FROM booking b
     JOIN shop s ON b.shop_id = s.shop_id
     JOIN customer c ON b.customer_id = c.customer_id
     LEFT JOIN payment p ON b.booking_id = p.booking_id
    LEFT JOIN (SELECT r1.* FROM refund r1 INNER JOIN (SELECT payment_id, MAX(refund_id) AS max_refund_id FROM refund GROUP BY payment_id) latest_refund ON latest_refund.payment_id = r1.payment_id AND latest_refund.max_refund_id = r1.refund_id) r ON r.payment_id = p.payment_id
     LEFT JOIN services srv ON b.service_id = srv.service_id
    LEFT JOIN delivery d ON b.booking_id = d.booking_id AND LOWER(REPLACE(b.booking_type, ' ', '')) = 'pickup'`;
    
    const queryParams = [];
    const whereClauses = [];
    
    if (shop_id) {
      whereClauses.push('b.shop_id = ?');
      queryParams.push(shop_id);
    }
    if (customer_id) {
      whereClauses.push('b.customer_id = ?');
      queryParams.push(customer_id);
    }
    if (status) {
      whereClauses.push('LOWER(b.status) = LOWER(?)');
      queryParams.push(status);
    }
    if (whereClauses.length) {
      sql += ` WHERE ${whereClauses.join(' AND ')}`;
    }
    
    // Order by appropriate date (newest first)
    sql += ` ORDER BY b.created_at DESC, b.booking_id DESC`;

  const [results] = await db.query(sql, queryParams);
    res.json(results);
  } catch (err) {
    console.error("DB Error (getBookings):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

// GET Booking by ID (with payment and service details)
exports.getBookingById = async (req, res) => {
  const { id } = req.params;

  try {
    const sql = `SELECT b.booking_id, b.booking_type, 
                        CASE 
                          WHEN b.booking_type LIKE '%pick up%' COLLATE utf8mb4_general_ci THEN b.pickup_date
                          ELSE b.booking_date
                        END AS service_date,
                        b.booking_date, b.pickup_date, b.created_at, b.status AS booking_status, b.total_amount, 
                        b.service_id, b.customer_id, srv.offers AS service_name, srv.description AS service_description,
                        s.name AS shop_name, c.first_name AS customer_first_name, c.last_name AS customer_last_name,
                        p.payment_id, p.payment_method, p.status AS payment_status, p.date,
                        r.refund_id, r.amount AS refund_amount, r.status AS refund_status,
                        d.delivery_id, d.pickup_address, d.delivery_address, d.delivery_time, d.status AS delivery_status
                 FROM booking b
                 JOIN shop s ON b.shop_id = s.shop_id
                 JOIN customer c ON b.customer_id = c.customer_id
                 LEFT JOIN services srv ON b.service_id = srv.service_id
                 LEFT JOIN payment p ON b.booking_id = p.booking_id
                 LEFT JOIN (SELECT r1.* FROM refund r1 INNER JOIN (SELECT payment_id, MAX(refund_id) AS max_refund_id FROM refund GROUP BY payment_id) latest_refund ON latest_refund.payment_id = r1.payment_id AND latest_refund.max_refund_id = r1.refund_id) r ON r.payment_id = p.payment_id
                 LEFT JOIN delivery d ON b.booking_id = d.booking_id AND LOWER(REPLACE(b.booking_type, ' ', '')) = 'pickup'
                 WHERE b.booking_id = ?`;

    const [results] = await db.query(sql, [id]);
    
    if (results.length === 0) return res.status(404).json({ message: 'Booking not found' });
    res.json(results[0]);
  } catch (err) {
    console.error("DB Error (getBookingById):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

// UPDATE Booking Status Only (Cancel booking triggers notification; Confirm triggers customer notification for walk-in)
exports.updateBookingStatus = async (req, res) => {
  const { id } = req.params;
  const { status, customer_id: requestedCustomerId, decline_reason: declineReason, decline_message: declineMessage } = req.body;

  if (!status) {
    return res.status(400).json({ message: 'Status is required' });
  }

  try {
    if (String(status).toLowerCase() === 'cancelled' && requestedCustomerId != null) {
      const [bookingRows] = await db.query(
        'SELECT customer_id, status FROM booking WHERE booking_id = ? LIMIT 1',
        [id]
      );
      if (!bookingRows.length) return res.status(404).json({ message: 'Booking not found' });
      if (Number(bookingRows[0].customer_id) !== Number(requestedCustomerId)) {
        return res.status(403).json({ message: 'You are not authorized to cancel this booking' });
      }
      if (String(bookingRows[0].status || '').toLowerCase() !== 'pending') {
        return res.status(400).json({ message: 'Customers can only cancel pending bookings' });
      }
    }

    const sql = `UPDATE booking SET status = ? WHERE booking_id = ?`;
    const [result] = await db.query(sql, [status, id]);
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    if (String(status).toLowerCase() === 'cancelled' && requestedCustomerId != null) {
      await db.query(
        `UPDATE payment
         SET status = 'cancelled'
         WHERE booking_id = ?
           AND LOWER(payment_method) IN ('cash', 'cod')
           AND LOWER(COALESCE(status, '')) = 'pending'`,
        [id]
      );
    }

  // Fetch booking info to target proper rooms and optionally customer notification
  const [shopRows] = await db.query(`
    SELECT b.shop_id, b.booking_type, b.customer_id, b.booking_date, s.name AS shop_name
    FROM booking b
    LEFT JOIN shop s ON s.shop_id = b.shop_id
    WHERE b.booking_id = ?
  `, [id]);
  const shopId = shopRows && shopRows[0] ? shopRows[0].shop_id : null;
  const bookingType = shopRows && shopRows[0] ? (shopRows[0].booking_type || '') : '';
  const customerId = shopRows && shopRows[0] ? shopRows[0].customer_id : null;
  const bookingDate = shopRows && shopRows[0] ? shopRows[0].booking_date : null;
  const shopName = shopRows && shopRows[0] ? shopRows[0].shop_name : null;
    if (shopId) {
      const io = req.app.get('io');
      emitBookingEvent(io, shopId, 'bookingUpdated', {
        bookingId: Number(id),
        status,
      });
      if (io && io.to) {
        io.to('role_superadmin').emit('bookingUpdated', {
          shopId,
          bookingId: Number(id),
          status,
          at: new Date().toISOString(),
        });
      }
      // Also notify the customer room for real-time updates in client apps
      try {
        if (io && io.to && customerId) {
          io.to(`user_customer_${customerId}`).emit('bookingUpdated', {
            bookingId: Number(id),
            status,
          });
        }
      } catch (e) {
        console.warn('⚠️ Failed to emit bookingUpdated to customer room:', e?.message || e);
      }
      // Send notification to admin if cancelled
      if (status && status.toLowerCase() === 'cancelled') {
        const adminInfo = await getAdminInfoByShop(shopId);
        if (adminInfo && adminInfo.admin_id) {
          // Enrich message with customer and service info
          let customerName = '';
          let serviceName = '';
          try {
            const [bookingRows] = await db.query(`
              SELECT c.first_name, c.last_name, srv.offers AS service_name
              FROM booking b
              JOIN customer c ON b.customer_id = c.customer_id
              LEFT JOIN services srv ON b.service_id = srv.service_id
              WHERE b.booking_id = ?
              LIMIT 1
            `, [id]);
            if (bookingRows && bookingRows[0]) {
              customerName = `${bookingRows[0].first_name} ${bookingRows[0].last_name}`.trim();
              serviceName = bookingRows[0].service_name || '';
            }
          } catch (e) { customerName = ''; serviceName = ''; }

          const base = customerName ? `${customerName} cancelled` : 'A customer cancelled';
          const details = serviceName ? ` booking for ${serviceName}` : ' a booking';
          const message = `${base}${details} (Booking #${id}).`;

          const { savedNotification } = await sendNotification({
            accountId: adminInfo.admin_id,
            accountType: 'admin',
            bookingId: id,
            title: 'Booking Cancelled',
            message,
            deviceToken: adminInfo.device_token || undefined,
            replaceExisting: true,
            existingTitles: ['New Service Booking', 'Booking Cancelled'],
          });

          // Emit real-time notification to the admin room
          try {
            const io = req.app.get('io');
            const userRoom = `user_admin_${adminInfo.admin_id}`;
            if (io && savedNotification) {
              io.to(userRoom).emit('newNotification', savedNotification);
            }
          } catch (e) {
            console.warn('⚠️ Failed to emit cancel notification via socket:', e?.message || e);
          }
        }

      }

  // Walk-in confirmation has its own notification. Pickup movement is tracked separately.
      if (status && status.toLowerCase() === 'confirmed' && customerId && (bookingType || '').toLowerCase() === 'walk in') {
        try {
          // Format booking date in PH locale (fallback to ISO if invalid)
          let formattedDate = '';
          try {
            const d = bookingDate ? new Date(bookingDate) : null;
            formattedDate = d && !isNaN(d.getTime())
              ? d.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' })
              : '';
          } catch (_) { formattedDate = ''; }
          const title = 'Walk-in Booking Confirmed';
          const message = `Your walk-in booking has been confirmed${formattedDate ? ` for ${formattedDate}` : ''}. Please bring your laundry on your scheduled date.`;

          // Save notification to DB

          const { savedNotification } = await sendNotification({
            accountId: customerId,
            accountType: 'customer',
            bookingId: id,
            title,
            message,
            replaceExisting: true,
            existingTitles: ['Walk-in Booking Confirmed', 'Booking Completed'],
          });

          // Emit via socket to the customer room
          try {
            const io = req.app.get('io');
            const userRoom = `user_customer_${customerId}`;
            if (io && savedNotification) {
              io.to(userRoom).emit('newNotification', savedNotification);
            }
          } catch (e) {
            console.warn('⚠️ Failed to emit confirm notification via socket:', e?.message || e);
          }

          // Send push to all active customer tokens (optional fan-out)
          try {
            const [tokenRows] = await db.query(
              `SELECT token FROM device_tokens WHERE account_id = ? AND account_type = 'customer' AND is_active = 1`,
              [customerId]
            );
            if (Array.isArray(tokenRows)) {
              for (const row of tokenRows) {
                try {
                  await require('../service/notificationService').sendPushOnly({
                    title,
                    message,
                    deviceToken: row.token,
                  });
                } catch (e) {
                  // Already handled inside sendPushOnly
                }
              }
            }
          } catch (e) {
            console.warn('⚠️ Failed to fan-out push for confirm:', e?.message || e);
          }
        } catch (e) {
          console.warn('⚠️ Failed to send customer confirm notification:', e?.message || e);
        }
      }

      // Send notification to customer when booking is completed
      if (status && status.toLowerCase() === 'completed' && customerId) {
        try {
          const title = 'Booking Completed';
          const message = `Your booking #${id} at ${shopName || 'the shop'} has been completed. Thank you for choosing us.`;

          // Save notification to DB (in-app)
          const { savedNotification } = await sendNotification({
            accountId: customerId,
            accountType: 'customer',
            bookingId: id,
            title,
            message,
          });

          // Emit via socket to the customer room for real-time in-app notification
          try {
            const io = req.app.get('io');
            const userRoom = `user_customer_${customerId}`;
            if (io && savedNotification) {
              io.to(userRoom).emit('newNotification', savedNotification);
            }
          } catch (e) {
            console.warn('⚠️ Failed to emit completion notification via socket:', e?.message || e);
          }

          // Fan-out push notifications to all active customer device tokens
          try {
            const [tokenRows] = await db.query(
              `SELECT token FROM device_tokens WHERE account_id = ? AND account_type = 'customer' AND is_active = 1`,
              [customerId]
            );
            if (Array.isArray(tokenRows)) {
              for (const row of tokenRows) {
                try {
                  await require('../service/notificationService').sendPushOnly({
                    title,
                    message,
                    deviceToken: row.token,
                  });
                } catch (e) {
                  // Errors handled in sendPushOnly (including invalid token cleanup)
                }
              }
            }
          } catch (e) {
            console.warn('⚠️ Failed to fan-out push for completion:', e?.message || e);
          }
        } catch (e) {
          console.warn('⚠️ Failed to send customer completion notification:', e?.message || e);
        }
      }
    }

    // Staff declines notify the customer independently of shop/socket metadata.
    if (status && status.toLowerCase() === 'declined' && customerId) {
      try {
        const title = 'Booking Declined';
        const trimmedDeclineMessage = declineMessage ? declineMessage.trim() : '';
        const reasonText = declineReason && declineReason !== 'Other'
          ? ` Reason: ${declineReason}.`
          : '';
        const messageText = trimmedDeclineMessage ? ` ${trimmedDeclineMessage}` : '';
        const message = `Your booking #${id} at ${shopName || 'the shop'} was declined.${reasonText}${messageText}`;

        const { savedNotification } = await sendNotification({
          accountId: customerId,
          accountType: 'customer',
          bookingId: id,
          title,
          message,
        });

        const io = req.app.get('io');
        if (io && savedNotification) {
          io.to(`user_customer_${customerId}`).emit('newNotification', savedNotification);
        }
      } catch (e) {
        console.error('❌ Failed to save/send decline notification:', e?.message || e);
      }
    }

    res.json({ 
      message: 'Booking status updated successfully',
      booking_id: id,
      new_status: status,
      refund: null
    });
  } catch (err) {
    console.error('Update booking status error:', err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

// UPDATE Booking Date (Reschedule triggers notification)
exports.updateBookingDate = async (req, res) => {
  const { id } = req.params;
  const { booking_date } = req.body;

  if (!booking_date) {
    return res.status(400).json({ message: 'booking_date is required' });
  }

  try {
    // Check current status to allow only pending/confirmed
    const [rows] = await db.query('SELECT status FROM booking WHERE booking_id = ?', [id]);
    if (!rows || rows.length === 0) return res.status(404).json({ message: 'Booking not found' });
    const currentStatus = (rows[0].status || '').toLowerCase();
    if (!['pending', 'confirmed'].includes(currentStatus)) {
      return res.status(400).json({ message: 'Reschedule allowed only for pending or confirmed bookings' });
    }

    const sql = `UPDATE booking SET booking_date = ? WHERE booking_id = ?`;
    const [result] = await db.query(sql, [booking_date, id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    // Emit update event so clients can refresh, and send notification
    const [shopRows] = await db.query('SELECT shop_id, status FROM booking WHERE booking_id = ?', [id]);
    const shopId = shopRows && shopRows[0] ? shopRows[0].shop_id : null;
    const status = shopRows && shopRows[0] ? shopRows[0].status : undefined;
    if (shopId) {
      const io = req.app.get('io');
      emitBookingEvent(io, shopId, 'bookingUpdated', {
        bookingId: Number(id),
        status,
        booking_date,
      });
      if (io && io.to) {
        io.to('role_superadmin').emit('bookingUpdated', {
          shopId,
          bookingId: Number(id),
          status,
          booking_date,
          at: new Date().toISOString(),
        });
      }
      // Also notify the customer for real-time updates
      try {
        // Fetch customer_id for this booking
        const [cRows] = await db.query('SELECT customer_id FROM booking WHERE booking_id = ? LIMIT 1', [id]);
        const cId = cRows && cRows[0] ? cRows[0].customer_id : null;
        if (io && io.to && cId) {
          io.to(`user_customer_${cId}`).emit('bookingUpdated', {
            bookingId: Number(id),
            status,
            booking_date,
          });
        }
      } catch (e) {
        console.warn('⚠️ Failed to emit bookingUpdated (date) to customer:', e?.message || e);
      }
      // Send notification to admin for reschedule, include customer name, new date, and service name
      const adminInfo = await getAdminInfoByShop(shopId);
  if (adminInfo && adminInfo.admin_id) {
        // Fetch customer name and service name
        let customerName = '';
        let serviceName = '';
        try {
          const [bookingRows] = await db.query(`
            SELECT c.first_name, c.last_name, srv.offers AS service_name
            FROM booking b
            JOIN customer c ON b.customer_id = c.customer_id
            LEFT JOIN services srv ON b.service_id = srv.service_id
            WHERE b.booking_id = ?
            LIMIT 1
          `, [id]);
          if (bookingRows && bookingRows[0]) {
            customerName = `${bookingRows[0].first_name} ${bookingRows[0].last_name}`.trim();
            serviceName = bookingRows[0].service_name || '';
          }
        } catch (e) { customerName = ''; serviceName = ''; }
        const formattedDate = new Date(booking_date).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
        // Construct a more natural message
        let notifMsg = '';
        if (customerName && serviceName) {
          notifMsg = `${customerName} rescheduled their booking for ${serviceName} to ${formattedDate}.`;
        } else if (customerName) {
          notifMsg = `${customerName} rescheduled their booking to ${formattedDate}.`;
        } else if (serviceName) {
          notifMsg = `A customer rescheduled their booking for ${serviceName} to ${formattedDate}.`;
        } else {
          notifMsg = `A booking was rescheduled to ${formattedDate}.`;
        }
        const { savedNotification } = await sendNotification({
          accountId: adminInfo.admin_id,
          accountType: 'admin',
          bookingId: id,
          title: 'Booking Rescheduled',
          message: notifMsg,
          deviceToken: adminInfo.device_token || undefined,
        });

        // Emit real-time notification to the admin room
        try {
          const io = req.app.get('io');
          const userRoom = `user_admin_${adminInfo.admin_id}`;
          if (io && savedNotification) {
            io.to(userRoom).emit('newNotification', savedNotification);
          }
        } catch (e) {
          console.warn('⚠️ Failed to emit reschedule notification via socket:', e?.message || e);
        }
      }
    }

    res.json({
      message: 'Booking date updated successfully',
      booking_id: id,
      booking_date,
    });
  } catch (err) {
    console.error('Update booking date error:', err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

const isDateOnly = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

const sendRescheduleNotification = async ({ accountId, accountType, bookingId, title, message }) => {
  try {
    const { savedNotification } = await sendNotification({ accountId, accountType, bookingId, title, message });
    return savedNotification;
  } catch (error) {
    console.warn('Reschedule notification failed:', error?.message || error);
    return null;
  }
};

// CUSTOMER: create a request without changing the booking date.
exports.createRescheduleRequest = async (req, res) => {
  const { id } = req.params;
  const { requested_date, reason, customer_id } = req.body;
  if (!customer_id || !requested_date) return res.status(400).json({ message: 'customer_id and requested_date are required' });
  if (!isDateOnly(requested_date)) return res.status(400).json({ message: 'requested_date must be a valid date in YYYY-MM-DD format' });

  try {
    const [bookings] = await db.query(
      'SELECT booking_id, booking_date, status, customer_id, shop_id FROM booking WHERE booking_id = ? LIMIT 1',
      [id]
    );
    const booking = bookings[0];
    if (!booking) return res.status(404).json({ message: 'Booking not found' });
    if (String(booking.customer_id) !== String(customer_id)) return res.status(403).json({ message: 'Booking does not belong to this customer' });
    if (!['confirmed', 'declined'].includes(String(booking.status).toLowerCase())) {
      return res.status(400).json({ message: 'Reschedule allowed only for confirmed or declined bookings' });
    }

    const currentDate = new Date(booking.booking_date).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    if (requested_date < today || requested_date < currentDate) {
      return res.status(400).json({ message: 'Requested date cannot be in the past or earlier than the current booking date' });
    }

    const [pending] = await db.query(
      "SELECT reschedule_id FROM booking_reschedule WHERE booking_id = ? AND status = 'Pending' LIMIT 1",
      [id]
    );
    if (pending.length) return res.status(409).json({ message: 'This booking already has a pending reschedule request' });

    const [result] = await db.query(
      'INSERT INTO booking_reschedule (booking_id, requested_date, reason, status) VALUES (?, ?, ?, \'Pending\')',
      [id, requested_date, reason || null]
    );

    const io = req.app.get('io');
    const [adminRows] = await db.query('SELECT admin_id FROM shop WHERE shop_id = ? LIMIT 1', [booking.shop_id]);
    const adminId = adminRows[0]?.admin_id;
    if (adminId) {
      const notification = await sendRescheduleNotification({
        accountId: adminId,
        accountType: 'admin',
        bookingId: id,
        title: 'Reschedule Request',
        message: `A customer requested to reschedule booking #${id} to ${requested_date}.`,
      });
      if (notification && io?.to) io.to(`user_admin_${adminId}`).emit('newNotification', notification);
      if (io?.to) io.to(`user_admin_${adminId}`).emit('rescheduleRequestCreated', { bookingId: Number(id), rescheduleId: result.insertId });
    }
    res.status(201).json({ message: 'Reschedule request submitted successfully', reschedule_id: result.insertId, status: 'Pending' });
  } catch (err) {
    console.error('Create reschedule request error:', err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

exports.getRescheduleRequest = async (req, res) => {
  const { id } = req.params;
  const { customer_id } = req.query;
  if (!customer_id) return res.status(400).json({ message: 'customer_id is required' });
  try {
    const [rows] = await db.query(
      `SELECT r.reschedule_id, r.booking_id, r.requested_date, r.reason, r.status, r.requested_at, r.reviewed_at
       FROM booking_reschedule r JOIN booking b ON b.booking_id = r.booking_id
       WHERE r.booking_id = ? AND b.customer_id = ? ORDER BY r.requested_at DESC LIMIT 1`,
      [id, customer_id]
    );
    res.json(rows[0] || null);
  } catch (err) {
    console.error('Get reschedule request error:', err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

exports.getRescheduleRequests = async (req, res) => {
  const { shop_id, booking_id } = req.query;
  if (!shop_id) return res.status(400).json({ message: 'shop_id is required' });
  try {
    const [rows] = await db.query(
      `SELECT r.reschedule_id, r.booking_id, r.requested_date, r.reason, r.status, r.requested_at, r.reviewed_at,
              b.booking_date, b.status AS booking_status, b.shop_id, c.first_name AS customer_first_name, c.last_name AS customer_last_name,
              srv.offers AS service_name
       FROM booking_reschedule r
       JOIN booking b ON b.booking_id = r.booking_id
       JOIN customer c ON c.customer_id = b.customer_id
       LEFT JOIN services srv ON srv.service_id = b.service_id
      WHERE b.shop_id = ?${booking_id ? ' AND b.booking_id = ?' : ''} ORDER BY r.requested_at DESC`,
          booking_id ? [shop_id, booking_id] : [shop_id]
    );
    res.json(rows);
  } catch (err) {
    console.error('Get reschedule requests error:', err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

const reviewReschedule = async (req, res, approved) => {
  const { id } = req.params;
  const { shop_id } = req.body;
  if (!shop_id) return res.status(400).json({ message: 'shop_id is required' });
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT r.reschedule_id, r.booking_id, r.requested_date, r.status AS reschedule_status,
              b.booking_date, b.status AS booking_status, b.customer_id, b.shop_id
       FROM booking_reschedule r JOIN booking b ON b.booking_id = r.booking_id
       WHERE r.reschedule_id = ? AND b.shop_id = ? LIMIT 1 FOR UPDATE`,
      [id, shop_id]
    );
    const request = rows[0];
    if (!request) { await connection.rollback(); return res.status(404).json({ message: 'Reschedule request not found' }); }
    if (request.reschedule_status !== 'Pending') { await connection.rollback(); return res.status(409).json({ message: 'Reschedule request has already been reviewed' }); }
    const bookingStatus = String(request.booking_status).toLowerCase();
    if (!['confirmed', 'declined'].includes(bookingStatus)) {
      await connection.rollback();
      return res.status(400).json({ message: 'Only confirmed or declined bookings can be reviewed' });
    }

    if (approved) {
      await connection.query(
        'UPDATE booking SET booking_date = ?, status = ? WHERE booking_id = ?',
        [request.requested_date, 'confirmed', request.booking_id]
      );
    }
    await connection.query('UPDATE booking_reschedule SET status = ?, reviewed_at = NOW() WHERE reschedule_id = ?', [approved ? 'Approved' : 'Rejected', id]);
    await connection.commit();

    const io = req.app.get('io');
    if (io?.to) {
      io.to(`user_customer_${request.customer_id}`).emit('bookingUpdated', {
        bookingId: Number(request.booking_id),
        status: approved ? 'Confirmed' : request.booking_status,
        ...(approved ? { booking_date: request.requested_date } : {}),
      });
      io.to(`user_customer_${request.customer_id}`).emit('rescheduleReviewed', { bookingId: Number(request.booking_id), status: approved ? 'Approved' : 'Rejected' });
    }
    const notification = await sendRescheduleNotification({
      accountId: request.customer_id,
      accountType: 'customer',
      bookingId: request.booking_id,
      title: approved ? 'Reschedule Approved' : 'Reschedule Rejected',
      message: approved ? `Your booking #${request.booking_id} was rescheduled to ${request.requested_date}.` : `Your reschedule request for booking #${request.booking_id} was rejected.`,
    });
    if (notification && io?.to) io.to(`user_customer_${request.customer_id}`).emit('newNotification', notification);
    res.json({ message: approved ? 'Reschedule request approved' : 'Reschedule request rejected', status: approved ? 'Approved' : 'Rejected', booking_date: approved ? request.requested_date : request.booking_date });
  } catch (err) {
    try { await connection.rollback(); } catch {}
    console.error('Review reschedule error:', err);
    res.status(500).json({ message: 'Database error', error: err.message });
  } finally {
    connection.release();
  }
};

exports.approveReschedule = (req, res) => reviewReschedule(req, res, true);
exports.rejectReschedule = (req, res) => reviewReschedule(req, res, false);

// UPDATE Booking
exports.updateBooking = async (req, res) => {
  const { id } = req.params;
  const { booking_type, booking_date, status, total_amount, shop_id, service_id, customer_id } = req.body;

  if (!booking_type || !booking_date || !status || !total_amount || !shop_id || !service_id || !customer_id) {
    return res.status(400).json({ message: 'All fields are required' });
  }

  try {
    const sql = `UPDATE booking 
                 SET booking_type=?, booking_date=?, status=?, total_amount=?, 
                     shop_id=?, service_id=?, customer_id=? 
                 WHERE booking_id=?`;

    const [result] = await db.query(sql, [booking_type, booking_date, status, total_amount, shop_id, service_id, customer_id, id]);
    
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Booking not found' });

    // Emit update event
    if (shop_id) {
      const io = req.app.get('io');
      emitBookingEvent(io, shop_id, 'bookingUpdated', {
        bookingId: Number(id),
        status,
        booking_date,
      });
    }

    res.json({ message: 'Booking updated successfully' });
  } catch (err) {
    console.error("DB Error (updateBooking):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

// DELETE Booking (and its payment if any)
exports.deleteBooking = async (req, res) => {
  const { id } = req.params;

  try {
    // Capture shop_id before deletion
    const [shopRows] = await db.query('SELECT shop_id FROM booking WHERE booking_id = ?', [id]);
    const shopId = shopRows && shopRows[0] ? shopRows[0].shop_id : null;

    // delete payment first then booking (foreign key safe)
    await db.query('DELETE FROM payment WHERE booking_id = ?', [id]);
    
    const [result] = await db.query('DELETE FROM booking WHERE booking_id = ?', [id]);
    
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Booking not found' });

    // Emit deleted event
    if (shopId) {
      const io = req.app.get('io');
      emitBookingEvent(io, shopId, 'bookingDeleted', { bookingId: Number(id) });
      if (io && io.to) {
        io.to('role_superadmin').emit('bookingDeleted', {
          shopId,
          bookingId: Number(id),
          at: new Date().toISOString(),
        });
      }
    }

    res.json({ message: 'Booking and payment deleted successfully' });
  } catch (err) {
    console.error("DB Error (deleteBooking):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};
