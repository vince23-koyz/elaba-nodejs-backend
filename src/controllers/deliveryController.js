const db = require('../config/db');
const { sendNotification } = require('../service/notificationService');

// Allowed delivery status states for pickup/delivery flow
const ALLOWED_STATUS = new Set([
  'pending',
  'confirmed',
  'ready', // ready for pickup or ready to dispatch
  'out_for_delivery', // courier en route
  'completed',
  'cancelled',
]);

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

  // Validate required fields
  if (!pickup_address || !delivery_address || !delivery_time || !status || !booking_id || !customer_id || !shop_id || !service_id) {
    return res.status(400).json({ message: 'All fields are required' });
  }

  const normalizedStatus = String(status).toLowerCase();
  if (!ALLOWED_STATUS.has(normalizedStatus)) {
    return res.status(400).json({ message: 'Invalid status value' });
  }

  try {
    // Validate booking exists and belongs to provided shop/customer/service
    const [bookingRows] = await db.query(
      'SELECT booking_id, booking_type, shop_id, customer_id, service_id FROM booking WHERE booking_id = ? LIMIT 1',
      [booking_id]
    );
    if (!bookingRows || bookingRows.length === 0) {
      return res.status(404).json({ message: 'Related booking not found' });
    }
    // Optional: ensure relations match
    const b = bookingRows[0];
    if (Number(b.shop_id) !== Number(shop_id) || Number(b.customer_id) !== Number(customer_id)) {
    const ALLOWED_STATUS = new Set([
      'pending',
      'confirmed',
      'ready', // ready for pickup or ready to dispatch
      'out_for_delivery', // courier en route
      'completed',
      'cancelled',
    ]);
      return res.status(400).json({ message: 'Mismatch between booking and provided shop/customer' });
    }

    const sql = `INSERT INTO delivery 
      (pickup_address, delivery_address, delivery_time, status, booking_id, customer_id, shop_id, service_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

    const [result] = await db.query(sql, [
      pickup_address, 
      delivery_address, 
      delivery_time, 
      status, 
      booking_id, 
      customer_id, 
      shop_id, 
      service_id
    ]);

    // Emit socket event for creation (notify admin and customer rooms)
    try {
      const io = req.app.get('io');
      if (io && io.to) {
        // Notify admin room for this shop
        // Find admin_id of the shop
        const [adminRows] = await db.query('SELECT admin_id FROM shop WHERE shop_id = ? LIMIT 1', [shop_id]);
        if (adminRows && adminRows[0] && adminRows[0].admin_id) {
          io.to(`user_admin_${adminRows[0].admin_id}`).emit('deliveryCreated', {
            delivery_id: result.insertId,
            booking_id,
            status: normalizedStatus,
            shop_id,
          });
        }
        // Notify customer room
        io.to(`user_customer_${customer_id}`).emit('deliveryCreated', {
          delivery_id: result.insertId,
          booking_id,
          status: normalizedStatus,
          shop_id,
        });
      }
    } catch (e) {
      console.warn('⚠️ Failed to emit deliveryCreated:', e?.message || e);
    }

    res.status(201).json({
      message: 'Delivery created successfully',
      delivery_id: result.insertId
    });
  } catch (err) {
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
             b.booking_type, b.booking_date, b.total_amount,
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
    sql += ` ORDER BY d.delivery_time DESC`;

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
             b.booking_type, b.booking_date, b.total_amount,
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

  if (!pickup_address || !delivery_address || !delivery_time || !status || !booking_id || !customer_id || !shop_id || !service_id) {
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
      delivery_address, 
      delivery_time, 
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
    const [rows] = await db.query('SELECT * FROM delivery WHERE delivery_id = ? LIMIT 1', [id]);
    if (!rows || rows.length === 0) return res.status(404).json({ message: 'Delivery not found' });
    const d = rows[0];

    const [result] = await db.query('UPDATE delivery SET status = ? WHERE delivery_id = ?', [normalizedStatus, id]);
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Delivery not found' });

    // Optionally keep booking status in sync for pickup-style bookings
    // Only set to some meaningful mapping
    try {
      const statusMap = {
        ready: 'ready',
        out_for_delivery: 'in_transit',
        completed: 'completed',
      };
      const mapped = statusMap[normalizedStatus];
      if (mapped) {
        await db.query('UPDATE booking SET status = ? WHERE booking_id = ?', [mapped, d.booking_id]);
      }
    } catch (e) {
      console.warn('⚠️ Failed to sync booking status from delivery:', e?.message || e);
    }

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

      // Send push + in-app notification to customer depending on status
      try {
        const [tokRows] = await db.query(
          `SELECT dt.token as device_token FROM device_tokens dt WHERE dt.account_id = ? AND dt.account_type = 'customer' AND dt.is_active = 1 LIMIT 1`,
          [d.customer_id]
        );
        const deviceToken = tokRows && tokRows[0] ? tokRows[0].device_token : undefined;

        let title = 'Delivery Update';
        let message = 'Your delivery status has been updated.';
        if (normalizedStatus === 'ready') {
          title = 'Laundry Ready for Pickup';
          message = `Your order #${d.booking_id} is ready for pickup.`;
        } else if (normalizedStatus === 'out_for_delivery') {
          title = 'Out for Delivery';
          message = `Your order #${d.booking_id} is now out for delivery.`;
        } else if (normalizedStatus === 'completed') {
          title = 'Delivery Completed';
          message = `Your order #${d.booking_id} has been completed.`;
        }

        await sendNotification({
          accountId: d.customer_id,
          accountType: 'customer',
          bookingId: d.booking_id,
          title,
          message,
          deviceToken,
        });
      } catch (e) {
        console.warn('⚠️ Failed to send delivery status notification:', e?.message || e);
      }
    } catch (e) {
      console.warn('⚠️ Failed to emit deliveryUpdated event:', e?.message || e);
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
