const db = require('../config/db');
const { sendNotification } = require('../service/notificationService');
const { sendPickupReadySms } = require('../service/pickupSmsService');

// Allowed delivery status states for pickup/delivery flow
const ALLOWED_STATUS = new Set([
  'pending',
  'out_for_pickup',
  'picked_up',
  'at_shop',
  'ready_for_delivery',
  'out_for_delivery', // courier en route
  'delivered',
  'cancelled',
]);

const NOTIFIABLE_DELIVERY_STATUS = new Set([
  'out_for_pickup',
  'picked_up',
  'at_shop',
  'ready_for_delivery',
  'out_for_delivery',
  'delivered',
]);

const DELIVERY_NOTIFICATION_TITLES = [
  'Booking Confirmed',
  'Out for Pickup',
  'Laundry Picked Up',
  'Laundry At Shop',
  'Laundry Ready for Delivery',
  'Out for Delivery',
  'Laundry Delivered',
];

exports.ensureDeliveryRecord = async ({
  booking_id,
  pickup_address,
  delivery_address,
  delivery_time = null,
  status = 'pending',
  customer_id,
  shop_id,
  service_id,
  io,
}) => {
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();
    const [bookingRows] = await connection.query(
      `SELECT b.booking_id, b.booking_type, b.shop_id, b.customer_id, b.service_id,
              c.street, c.zone, c.barangay, c.city
       FROM booking b
       INNER JOIN customer c ON c.customer_id = b.customer_id
       WHERE b.booking_id = ?
       LIMIT 1
       FOR UPDATE`,
      [booking_id]
    );
    if (!bookingRows.length) {
      const error = new Error('Related booking not found');
      error.statusCode = 404;
      throw error;
    }

    const booking = bookingRows[0];
    if (
      (customer_id != null && Number(booking.customer_id) !== Number(customer_id)) ||
      (shop_id != null && Number(booking.shop_id) !== Number(shop_id)) ||
      (service_id != null && Number(booking.service_id) !== Number(service_id))
    ) {
      const error = new Error('Mismatch between booking and provided customer, shop, or service');
      error.statusCode = 400;
      throw error;
    }

    const [existingRows] = await connection.query(
      'SELECT delivery_id, status FROM delivery WHERE booking_id = ? LIMIT 1 FOR UPDATE',
      [booking_id]
    );
    if (existingRows.length) {
      await connection.commit();
      return {
        delivery_id: existingRows[0].delivery_id,
        booking_id: booking.booking_id,
        status: existingRows[0].status,
        shop_id: booking.shop_id,
        customer_id: booking.customer_id,
        created: false,
      };
    }

    const profileAddress = [booking.street, booking.zone, booking.barangay, booking.city]
      .filter((part) => String(part || '').trim())
      .join(', ');
    const resolvedPickupAddress = String(pickup_address || profileAddress).trim();
    if (!resolvedPickupAddress) {
      const error = new Error('Pickup address is unavailable for this booking');
      error.statusCode = 409;
      throw error;
    }

    const normalizedStatus = String(status).toLowerCase();
    if (!ALLOWED_STATUS.has(normalizedStatus)) {
      const error = new Error('Invalid status value');
      error.statusCode = 400;
      throw error;
    }

    const [result] = await connection.query(
      `INSERT INTO delivery
        (pickup_address, delivery_address, delivery_time, status, booking_id, customer_id, shop_id, service_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        resolvedPickupAddress,
        delivery_address || resolvedPickupAddress,
        delivery_time,
        normalizedStatus,
        booking.booking_id,
        booking.customer_id,
        booking.shop_id,
        booking.service_id,
      ]
    );
    await connection.commit();

    try {
      if (io && io.to) {
        const [adminRows] = await db.query('SELECT admin_id FROM shop WHERE shop_id = ? LIMIT 1', [booking.shop_id]);
        if (adminRows[0]?.admin_id) {
          io.to(`user_admin_${adminRows[0].admin_id}`).emit('deliveryCreated', {
            delivery_id: result.insertId,
            booking_id: booking.booking_id,
            status: normalizedStatus,
            shop_id: booking.shop_id,
          });
        }
        io.to(`user_customer_${booking.customer_id}`).emit('deliveryCreated', {
          delivery_id: result.insertId,
          booking_id: booking.booking_id,
          status: normalizedStatus,
          shop_id: booking.shop_id,
        });
      }
    } catch (error) {
      console.warn('Failed to emit deliveryCreated:', error?.message || error);
    }

    return {
      delivery_id: result.insertId,
      booking_id: booking.booking_id,
      status: normalizedStatus,
      shop_id: booking.shop_id,
      customer_id: booking.customer_id,
      created: true,
    };
  } catch (error) {
    try { await connection.rollback(); } catch (_) { /* rollback best effort */ }
    throw error;
  } finally {
    connection.release();
  }
};

exports.createDelivery = async (req, res) => {
  const { 
    pickup_address, 
    delivery_address, 
    delivery_time, 
    status, 
    booking_id, 
    customer_id, 
    shop_id, 
    service_id 
  } = req.body;

  // Validate required fields (delivery_address and delivery_time can be null for pending pickups)
  if (!pickup_address || !status || !booking_id || !customer_id || !shop_id || !service_id) {
    return res.status(400).json({ message: 'All fields are required' });
  }

  const normalizedStatus = String(status).toLowerCase();
  if (!ALLOWED_STATUS.has(normalizedStatus)) {
    return res.status(400).json({ message: 'Invalid status value' });
  }

  try {
    const delivery = await exports.ensureDeliveryRecord({
      pickup_address,
      delivery_address,
      delivery_time,
      status: normalizedStatus,
      booking_id,
      customer_id,
      shop_id,
      service_id,
      io: req.app.get('io'),
    });
    res.status(delivery.created ? 201 : 200).json({
      message: delivery.created ? 'Delivery created successfully' : 'Delivery already exists for this booking',
      delivery_id: delivery.delivery_id,
    });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ message: err.message });
    console.error("DB Error (createDelivery):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

// GET ALL Deliveries (with booking and customer info)
exports.getDeliveries = async (req, res) => {
  try {
    const { shop_id, customer_id, booking_id } = req.query;

    let sql = `
      SELECT d.*, 
             b.booking_type, b.booking_date, b.pickup_date, b.status AS booking_status, b.total_amount,
             c.first_name AS customer_first_name, c.last_name AS customer_last_name,
             s.name AS shop_name,
             srv.offers AS service_name
      FROM delivery d
      JOIN booking b ON d.booking_id = b.booking_id
      JOIN customer c ON d.customer_id = c.customer_id
      JOIN shop s ON d.shop_id = s.shop_id
      JOIN services srv ON d.service_id = srv.service_id`;

    const where = [];
    const params = [];
    if (shop_id) { where.push('d.shop_id = ?'); params.push(shop_id); }
    if (customer_id) { where.push('d.customer_id = ?'); params.push(customer_id); }
    if (booking_id) { where.push('d.booking_id = ?'); params.push(booking_id); }
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ` ORDER BY COALESCE(d.delivery_time, b.pickup_date) DESC`;

    const [results] = await db.query(sql, params);
    res.json(results);
  } catch (err) {
    console.error("DB Error (getDeliveries):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

// GET Delivery by ID
exports.getDeliveryById = async (req, res) => {
  const { id } = req.params;

  try {
    const sql = `
      SELECT d.*, 
             b.booking_type, b.booking_date, b.pickup_date, b.total_amount,
             c.first_name AS customer_first_name, c.last_name AS customer_last_name,
             s.name AS shop_name,
             srv.offers AS service_name
      FROM delivery d
      JOIN booking b ON d.booking_id = b.booking_id
      JOIN customer c ON d.customer_id = c.customer_id
      JOIN shop s ON d.shop_id = s.shop_id
      JOIN services srv ON d.service_id = srv.service_id
      WHERE d.delivery_id = ?
    `;

    const [results] = await db.query(sql, [id]);
    if (results.length === 0) return res.status(404).json({ message: 'Delivery not found' });
    res.json(results[0]);
  } catch (err) {
    console.error("DB Error (getDeliveryById):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

// UPDATE Delivery
exports.updateDelivery = async (req, res) => {
  const { id } = req.params;
  const { pickup_address, delivery_address, delivery_time, status, booking_id, customer_id, shop_id, service_id } = req.body;

  const normalizedDeliveryAddress = delivery_address ?? null;
  const normalizedDeliveryTime = delivery_time ?? null;

  if (!pickup_address || !status || !booking_id || !customer_id || !shop_id || !service_id) {
    return res.status(400).json({ message: 'All fields are required' });
  }

  const normalizedStatus = String(status).toLowerCase();
  if (!ALLOWED_STATUS.has(normalizedStatus)) {
    return res.status(400).json({ message: 'Invalid status value' });
  }

  try {
    const sql = `
      UPDATE delivery 
      SET pickup_address=?, delivery_address=?, delivery_time=?, status=?, 
          booking_id=?, customer_id=?, shop_id=?, service_id=? 
      WHERE delivery_id=?`;

    const [result] = await db.query(sql, [
      pickup_address, 
      normalizedDeliveryAddress, 
      normalizedDeliveryTime, 
      status, 
      booking_id, 
      customer_id, 
      shop_id, 
      service_id, 
      id
    ]);
    
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Delivery not found' });

    // Emit update event to admin and customer rooms
    try {
      const io = req.app.get('io');
      if (io && io.to) {
        const [adminRows] = await db.query('SELECT admin_id FROM shop WHERE shop_id = ? LIMIT 1', [shop_id]);
        if (adminRows && adminRows[0] && adminRows[0].admin_id) {
          io.to(`user_admin_${adminRows[0].admin_id}`).emit('deliveryUpdated', {
            delivery_id: Number(id),
            booking_id,
            status: normalizedStatus,
            shop_id,
          });
        }
        io.to(`user_customer_${customer_id}`).emit('deliveryUpdated', {
          delivery_id: Number(id),
          booking_id,
          status: normalizedStatus,
          shop_id,
        });
      }
    } catch (e) {
      console.warn('⚠️ Failed to emit deliveryUpdated:', e?.message || e);
    }
    res.json({ message: 'Delivery updated successfully' });
  } catch (err) {
    console.error("DB Error (updateDelivery):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

// PATCH Delivery status only
exports.updateDeliveryStatus = async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!status) return res.status(400).json({ message: 'Status is required' });
  const normalizedStatus = String(status).toLowerCase();
  if (!ALLOWED_STATUS.has(normalizedStatus)) {
    return res.status(400).json({ message: 'Invalid status value' });
  }

  try {
    // Fetch delivery for context
    const [rows] = await db.query(`
      SELECT d.*, s.name AS shop_name, b.booking_type, b.total_amount,
             (SELECT p.payment_method
              FROM payment p
              WHERE p.booking_id = b.booking_id
              ORDER BY p.payment_id DESC
              LIMIT 1) AS payment_method,
             c.phone_number, c.first_name AS customer_first_name
      FROM delivery d
      LEFT JOIN shop s ON s.shop_id = d.shop_id
      LEFT JOIN booking b ON b.booking_id = d.booking_id
      LEFT JOIN customer c ON c.customer_id = d.customer_id
      WHERE d.delivery_id = ?
      LIMIT 1
    `, [id]);
    if (!rows || rows.length === 0) return res.status(404).json({ message: 'Delivery not found' });
    const d = rows[0];

    const [result] = await db.query('UPDATE delivery SET status = ? WHERE delivery_id = ?', [normalizedStatus, id]);
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Delivery not found' });
    const isPickupBooking = String(d.booking_type || '').trim().toLowerCase().replace(/[\s-]/g, '') === 'pickup';
    const wasOutForDelivery = String(d.status || '').toLowerCase() === 'out_for_delivery';

    // Emit socket event and send notification to customer
    try {
      const io = req.app.get('io');
      if (io && io.to) {
        // Admin room
        const [adminRows] = await db.query('SELECT admin_id FROM shop WHERE shop_id = ? LIMIT 1', [d.shop_id]);
        if (adminRows && adminRows[0] && adminRows[0].admin_id) {
          io.to(`user_admin_${adminRows[0].admin_id}`).emit('deliveryUpdated', {
            delivery_id: Number(id),
            booking_id: d.booking_id,
            status: normalizedStatus,
            shop_id: d.shop_id,
          });
        }
        // Customer room
        io.to(`user_customer_${d.customer_id}`).emit('deliveryUpdated', {
          delivery_id: Number(id),
          booking_id: d.booking_id,
          status: normalizedStatus,
          shop_id: d.shop_id,
        });
      }

      // Notify only on major delivery milestones; every status still reaches the UI via socket.
      if (NOTIFIABLE_DELIVERY_STATUS.has(normalizedStatus)) try {
        const [tokRows] = await db.query(
          `SELECT dt.token as device_token FROM device_tokens dt WHERE dt.account_id = ? AND dt.account_type = 'customer' AND dt.is_active = 1 LIMIT 1`,
          [d.customer_id]
        );
        const deviceToken = tokRows && tokRows[0] ? tokRows[0].device_token : undefined;

        let title = 'Delivery Update';
        let message = 'Your delivery status has been updated.';
        if (normalizedStatus === 'out_for_pickup') {
          title = 'Out for Pickup';
          message = `Pickup for booking #${d.booking_id} is on the way.`;
        } else if (normalizedStatus === 'picked_up') {
          title = 'Laundry Picked Up';
          message = `Your laundry for booking #${d.booking_id} has been picked up.`;
        } else if (normalizedStatus === 'at_shop') {
          title = 'Laundry At Shop';
          message = `Your laundry for booking #${d.booking_id} has arrived at the shop.`;
        } else if (normalizedStatus === 'ready_for_delivery') {
          title = 'Laundry Ready for Delivery';
          message = `Your booking #${d.booking_id} is ready for delivery.`;
        } else if (normalizedStatus === 'out_for_delivery') {
          title = 'Out for Delivery';
          message = `Your booking #${d.booking_id} is now out for delivery.`;
        } else if (normalizedStatus === 'delivered') {
          title = 'Laundry Delivered';
          message = `Your booking #${d.booking_id} at ${d.shop_name || 'the shop'} has been delivered.`;
        }

        const { savedNotification } = await sendNotification({
          accountId: d.customer_id,
          accountType: 'customer',
          bookingId: d.booking_id,
          title,
          message,
          deviceToken,
          replaceExisting: true,
          existingTitles: DELIVERY_NOTIFICATION_TITLES,
        });
        if (savedNotification && io?.to) {
          io.to(`user_customer_${d.customer_id}`).emit('newNotification', savedNotification);
        }
      } catch (e) {
        console.warn('⚠️ Failed to send delivery status notification:', e?.message || e);
      }
    } catch (e) {
      console.warn('⚠️ Failed to emit deliveryUpdated event:', e?.message || e);
    }

    if (
      normalizedStatus === 'out_for_delivery' &&
      !wasOutForDelivery &&
      isPickupBooking
    ) {
      try {
        await sendPickupReadySms({
          phoneNumber: d.phone_number,
          customerFirstName: d.customer_first_name,
          bookingId: d.booking_id,
          totalAmount: d.total_amount,
          paymentMethod: d.payment_method,
        });
      } catch (e) {
        console.error('Failed to send pickup out-for-delivery SMS:', e?.message || e);
      }
    }

    res.json({ message: 'Delivery status updated', delivery_id: Number(id), status: normalizedStatus });
  } catch (err) {
    console.error('DB Error (updateDeliveryStatus):', err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

// DELETE Delivery
exports.deleteDelivery = async (req, res) => {
  const { id } = req.params;

  try {
    const [result] = await db.query('DELETE FROM delivery WHERE delivery_id = ?', [id]);
    
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Delivery not found' });
    res.json({ message: 'Delivery deleted successfully' });
  } catch (err) {
    console.error("DB Error (deleteDelivery):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};
