const db = require('../config/db'); 
const { sendNotification } = require('../service/notificationService');

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

// CREATE Booking
exports.createBooking = async (req, res) => {
  const { booking_type, booking_date, status, total_amount, shop_id, service_id, customer_id } = req.body;

  // Debug log
  console.log('Create Booking:', req.body);

  // Validate required fields
  if (!booking_type || !booking_date || !status || !total_amount || !shop_id || !service_id || !customer_id) {
    return res.status(400).json({ message: 'All fields are required' });
  }

  try {
    const sql = `INSERT INTO booking (booking_type, booking_date, status, total_amount, shop_id, service_id, customer_id) 
                 VALUES (?, ?, ?, ?, ?, ?, ?)`;

    const [result] = await db.query(sql, [booking_type, booking_date, status, total_amount, shop_id, service_id, customer_id]);

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

// GET ALL Bookings (with payment info if any)
exports.getBookings = async (req, res) => {
  const { shop_id, customer_id } = req.query; // Optional filters
  
  try {
    let sql = `SELECT b.booking_id, b.booking_type, b.booking_date, b.status AS booking_status, b.total_amount, 
       b.shop_id, b.customer_id, s.name AS shop_name, c.first_name AS customer_first_name, c.last_name AS customer_last_name,
       p.payment_id, p.payment_method, p.status AS payment_status, p.date,
       b.service_id, srv.offers AS service_name
     FROM booking b
     JOIN shop s ON b.shop_id = s.shop_id
     JOIN customer c ON b.customer_id = c.customer_id
     LEFT JOIN payment p ON b.booking_id = p.booking_id
     LEFT JOIN services srv ON b.service_id = srv.service_id`;
    
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
    if (whereClauses.length) {
      sql += ` WHERE ${whereClauses.join(' AND ')}`;
    }
    
    // Order by booking date (newest first)
    sql += ` ORDER BY b.booking_date DESC`;

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
    const sql = `SELECT b.booking_id, b.booking_type, b.booking_date, b.status AS booking_status, b.total_amount, 
                        b.service_id, b.customer_id, srv.offers AS service_name, srv.description AS service_description,
                        s.name AS shop_name, c.first_name AS customer_first_name, c.last_name AS customer_last_name,
                        p.payment_id, p.payment_method, p.status AS payment_status, p.date
                 FROM booking b
                 JOIN shop s ON b.shop_id = s.shop_id
                 JOIN customer c ON b.customer_id = c.customer_id
                 LEFT JOIN services srv ON b.service_id = srv.service_id
                 LEFT JOIN payment p ON b.booking_id = p.booking_id
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
  const { status } = req.body;

  if (!status) {
    return res.status(400).json({ message: 'Status is required' });
  }

  try {
    const sql = `UPDATE booking SET status = ? WHERE booking_id = ?`;
    const [result] = await db.query(sql, [status, id]);
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Booking not found' });
    }

  // Fetch booking info to target proper rooms and optionally customer notification
  const [shopRows] = await db.query('SELECT shop_id, booking_type, customer_id, booking_date FROM booking WHERE booking_id = ?', [id]);
  const shopId = shopRows && shopRows[0] ? shopRows[0].shop_id : null;
  const bookingType = shopRows && shopRows[0] ? (shopRows[0].booking_type || '') : '';
  const customerId = shopRows && shopRows[0] ? shopRows[0].customer_id : null;
  const bookingDate = shopRows && shopRows[0] ? shopRows[0].booking_date : null;
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
          const message = `${base}${details} (Order #${id}).`;

          const { savedNotification } = await sendNotification({
            accountId: adminInfo.admin_id,
            accountType: 'admin',
            bookingId: id,
            title: 'Booking Cancelled',
            message,
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
            console.warn('⚠️ Failed to emit cancel notification via socket:', e?.message || e);
          }
        }
      }

      // Send notification to customer if confirmed and booking is walk-in
      if (status && status.toLowerCase() === 'confirmed' && customerId) {
        try {
          const isWalkIn = (bookingType || '').toLowerCase() === 'walk in';
          // Build localized message
          let title = 'Booking Confirmed';
          let message = '';
          if (isWalkIn) {
            // Format booking date in PH locale (fallback to ISO if invalid)
            let formattedDate = '';
            try {
              const d = bookingDate ? new Date(bookingDate) : null;
              formattedDate = d && !isNaN(d.getTime())
                ? d.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' })
                : '';
            } catch (_) { formattedDate = ''; }
            title = 'Walk-in Booking Confirmed';
            message = `Nakumpirma na ang walk-in booking mo${formattedDate ? ` para sa ${formattedDate}` : ''}. Dalhin na lang ang palalabhan mo sa mismong booking date.`;
          } else {
            // Generic confirmation for non walk-in
            message = `Your booking #${id} has been confirmed.`;
          }

          // Save notification to DB
          const { savedNotification } = await sendNotification({
            accountId: customerId,
            accountType: 'customer',
            bookingId: id,
            title,
            message,
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
    }

    res.json({ 
      message: 'Booking status updated successfully',
      booking_id: id,
      new_status: status
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
