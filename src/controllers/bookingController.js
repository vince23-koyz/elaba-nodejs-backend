const db = require('../config/db');
const { sendNotification } = require('../service/notificationService');
const paymongoService = require('../service/paymongoService');
const deliveryController = require('./deliveryController');

const PRICE_CONFIRMATION_READY_STATUSES = new Set(['confirmed', 'awaiting_customer', 'accepted', 'declined']);

function isPriceConfirmationReady(status) {
  return PRICE_CONFIRMATION_READY_STATUSES.has(String(status || '').toLowerCase());
}

async function getBookingStatusContext(bookingId) {
  const [rows] = await db.query(
    `SELECT b.booking_id, b.customer_id, b.shop_id, b.booking_type, b.status,
            b.request_idempotency_key, b.price_confirmation_status,
            d.status AS delivery_status, s.admin_id,
            (SELECT p.payment_method
             FROM payment p
             WHERE p.booking_id = b.booking_id
             ORDER BY p.payment_id DESC
             LIMIT 1) AS payment_method,
            (SELECT p.status
             FROM payment p
             WHERE p.booking_id = b.booking_id
             ORDER BY p.payment_id DESC
             LIMIT 1) AS payment_status,
            (SELECT p.transaction_id
             FROM payment p
             WHERE p.booking_id = b.booking_id
             ORDER BY p.payment_id DESC
             LIMIT 1) AS transaction_id
     FROM booking b
     LEFT JOIN delivery d ON d.booking_id = b.booking_id
     LEFT JOIN shop s ON s.shop_id = b.shop_id
     WHERE b.booking_id = ?
     LIMIT 1`,
    [bookingId],
  );
  return rows[0] || null;
}

function getBookingCompletionError(booking) {
  if (booking.request_idempotency_key && !isPriceConfirmationReady(booking.price_confirmation_status)) {
    return 'The shop must confirm the total amount before completing this laundry request.';
  }

  const bookingType = String(booking.booking_type || '').toLowerCase().replace(/[\s-]/g, '');
  const paymentMethod = String(booking.payment_method || '').toLowerCase();
  const isPickup = bookingType.includes('pickup');
  const isDelivery = bookingType.includes('delivery');
  const requiresDeliveryProgress = isPickup || isDelivery;
  if (!requiresDeliveryProgress) return null;

  if (String(booking.delivery_status || '').toLowerCase() !== 'delivered') {
    return 'The laundry must be physically marked delivered before completing this booking.';
  }
  if (!['paid', 'success', 'succeeded', 'completed'].includes(String(booking.payment_status || '').toLowerCase())) {
    return 'Confirm payment before completing this booking.';
  }
  if (paymentMethod === 'qrph' && !booking.transaction_id) {
    return 'PayMongo must verify the QR Ph payment before completing this booking.';
  }
  return null;
}

// Helper: get the admin account for a given shop_id
async function getAdminInfoByShop(shopId) {
  try {
    const [rows] = await db.query(`
      SELECT s.admin_id
      FROM shop s
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

async function activatePaidGcashBooking(bookingId, io) {
  const [result] = await db.query(
    `UPDATE booking b
     INNER JOIN payment p ON p.booking_id = b.booking_id
     SET b.status = 'Pending'
     WHERE b.booking_id = ?
       AND LOWER(COALESCE(b.status, '')) = 'payment_pending'
       AND (b.request_idempotency_key IS NULL OR b.price_confirmation_status IN ('confirmed', 'awaiting_customer', 'accepted', 'declined'))
       AND LOWER(COALESCE(p.payment_method, '')) = 'gcash'
       AND LOWER(COALESCE(p.status, '')) = 'paid'`,
    [bookingId]
  );
  if (!result.affectedRows) return false;

  const [rows] = await db.query(
    `SELECT b.booking_id, b.shop_id, b.customer_id, s.admin_id,
            c.first_name, c.last_name, srv.offers AS service_name
     FROM booking b
     INNER JOIN shop s ON s.shop_id = b.shop_id
     INNER JOIN customer c ON c.customer_id = b.customer_id
     LEFT JOIN services srv ON srv.service_id = b.service_id
     WHERE b.booking_id = ?
     LIMIT 1`,
    [bookingId]
  );
  const booking = rows[0];
  if (!booking) return true;

  emitBookingEvent(io, booking.shop_id, 'bookingCreated', {
    bookingId: Number(booking.booking_id),
    status: 'Pending',
  });
  if (io && io.to) {
    io.to('role_superadmin').emit('bookingCreated', {
      shopId: booking.shop_id,
      bookingId: Number(booking.booking_id),
      status: 'Pending',
      at: new Date().toISOString(),
    });
  }
  if (booking.admin_id) {
    try {
      const customerName = `${booking.first_name || ''} ${booking.last_name || ''}`.trim() || 'A customer';
      const serviceName = booking.service_name || 'a service';
      const { savedNotification } = await sendNotification({
        accountId: booking.admin_id,
        accountType: 'admin',
        bookingId: booking.booking_id,
        title: 'New Service Booking',
        message: `A new service booking has just been received from ${customerName} for ${serviceName}! Please check the details and confirm the booking to begin processing.`,
      });
      if (savedNotification && io && io.to) {
        io.to(`user_admin_${booking.admin_id}`).emit('newNotification', savedNotification);
      }
    } catch (error) {
      console.error('Error sending paid GCash booking notification:', error);
    }
  }
  return true;
}

async function discardFailedGcashBooking(bookingId, customerId = null) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT b.booking_id, b.customer_id, b.status AS booking_status,
              p.payment_id, p.status AS payment_status, p.payment_method
       FROM booking b
       INNER JOIN payment p ON p.booking_id = b.booking_id
       WHERE b.booking_id = ?
         AND NOT EXISTS (
           SELECT 1
           FROM payment active_payment
           WHERE active_payment.booking_id = b.booking_id
             AND LOWER(COALESCE(active_payment.status, '')) NOT IN ('failed', 'cancelled')
         )
         AND LOWER(COALESCE(p.status, '')) IN ('failed', 'cancelled')
       LIMIT 1
       FOR UPDATE`,
      [bookingId]
    );
    if (!rows.length) {
      await connection.commit();
      return { deleted: false, reason: 'not_found' };
    }

    const booking = rows[0];
    if (customerId != null && Number(booking.customer_id) !== Number(customerId)) {
      await connection.rollback();
      return { deleted: false, reason: 'unauthorized' };
    }
    if (
      String(booking.payment_method || '').toLowerCase() !== 'gcash' ||
      !['failed', 'cancelled'].includes(String(booking.payment_status || '').toLowerCase())
    ) {
      await connection.commit();
      return { deleted: false, reason: 'payment_not_failed' };
    }
    if (!['payment_pending', 'pending', 'cancelled'].includes(String(booking.booking_status || '').toLowerCase())) {
      await connection.commit();
      return { deleted: false, reason: 'booking_already_advanced' };
    }

    await connection.query('DELETE FROM booking WHERE booking_id = ?', [booking.booking_id]);
    await connection.commit();
    return { deleted: true, booking_id: booking.booking_id };
  } catch (error) {
    try { await connection.rollback(); } catch (_) { /* rollback best effort */ }
    throw error;
  } finally {
    connection.release();
  }
}

async function discardUnstartedGcashBooking(bookingId, customerId) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT b.booking_id, b.customer_id, b.status
       FROM booking b
       WHERE b.booking_id = ?
       LIMIT 1
       FOR UPDATE`,
      [bookingId]
    );
    if (!rows.length) {
      await connection.commit();
      return { deleted: false, reason: 'not_found' };
    }
    const booking = rows[0];
    if (Number(booking.customer_id) !== Number(customerId)) {
      await connection.rollback();
      return { deleted: false, reason: 'unauthorized' };
    }
    if (String(booking.status || '').toLowerCase() !== 'payment_pending') {
      await connection.commit();
      return { deleted: false, reason: 'booking_already_advanced' };
    }
    const [paymentRows] = await connection.query(
      'SELECT payment_id FROM payment WHERE booking_id = ? LIMIT 1 FOR UPDATE',
      [bookingId]
    );
    if (paymentRows.length) {
      await connection.commit();
      return { deleted: false, reason: 'payment_record_exists' };
    }

    await connection.query('DELETE FROM booking WHERE booking_id = ?', [bookingId]);
    await connection.commit();
    return { deleted: true, booking_id: Number(bookingId) };
  } catch (error) {
    try { await connection.rollback(); } catch (_) { /* rollback best effort */ }
    throw error;
  } finally {
    connection.release();
  }
}

exports.activatePaidGcashBooking = activatePaidGcashBooking;
exports.discardFailedGcashBooking = discardFailedGcashBooking;
exports.discardUnstartedGcashBooking = discardUnstartedGcashBooking;

// CREATE Booking
exports.createBooking = async (req, res) => {
  const body = req.body || {};
  const isLaundryRequest = body.request_mode === 'laundry_request';

  if (
    Object.prototype.hasOwnProperty.call(body, 'request_mode') &&
    !isLaundryRequest
  ) {
    return res.status(400).json({ message: 'request_mode is invalid' });
  }

  const {
    booking_type, total_amount, shop_id, service_id,
    customer_id, estimated_weight_kg,
  } = body;
  let { status } = body;
  const isPaymentDraft = !isLaundryRequest && String(status).toLowerCase() === 'payment_pending';

  let idempotencyKey;
  let pickupDetails = null;
  if (isLaundryRequest) {
    const pickupFields = ['pickup_address', 'delivery_address'];
    const allowedFields = new Set([
      'request_mode',
      'booking_type',
      'shop_id',
      'service_id',
      ...pickupFields,
    ]);
    if (Object.keys(body).some(field => !allowedFields.has(field))) {
      return res.status(400).json({
        message: 'Laundry requests cannot include customer, amount, date, weight, or booking status fields',
      });
    }

    idempotencyKey = String(req.get('Idempotency-Key') || '').trim().toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(idempotencyKey)) {
      return res.status(400).json({ message: 'A valid Idempotency-Key UUID is required' });
    }
    if (!['Pick up', 'Walk in'].includes(booking_type)) {
      return res.status(400).json({ message: 'booking_type must be Pick up or Walk in' });
    }
    if (booking_type === 'Pick up') {
      const pickupAddress = typeof body.pickup_address === 'string' ? body.pickup_address.trim() : '';
      const deliveryAddress = typeof body.delivery_address === 'string' ? body.delivery_address.trim() : '';
      if (!pickupAddress || pickupAddress.length > 255) {
        return res.status(400).json({ message: 'pickup_address is required and must be 255 characters or fewer' });
      }
      if (!deliveryAddress || deliveryAddress.length > 255) {
        return res.status(400).json({ message: 'delivery_address is required and must be 255 characters or fewer' });
      }
      pickupDetails = {
        pickup_address: pickupAddress,
        delivery_address: deliveryAddress,
      };
    } else if (pickupFields.some(field => Object.prototype.hasOwnProperty.call(body, field))) {
      return res.status(400).json({ message: 'Pickup details are only valid for Pick up requests' });
    }

    const parsePositiveInteger = value => {
      if (typeof value !== 'number' && typeof value !== 'string') return null;
      const normalizedValue = typeof value === 'string' ? value.trim() : value;
      if (normalizedValue === '' || !/^\d+$/.test(String(normalizedValue))) return null;
      const parsedValue = Number(normalizedValue);
      return Number.isSafeInteger(parsedValue) && parsedValue > 0 ? parsedValue : null;
    };
    const parsedShopId = parsePositiveInteger(shop_id);
    if (parsedShopId === null) {
      return res.status(400).json({ message: 'shop_id must be a positive integer' });
    }
    const parsedServiceId = parsePositiveInteger(service_id);
    if (parsedServiceId === null) {
      return res.status(400).json({ message: 'service_id must be a positive integer' });
    }
    if (!Number.isSafeInteger(req.authenticatedCustomerId) || req.authenticatedCustomerId <= 0) {
      return res.status(401).json({ message: 'A valid customer login is required.' });
    }

    status = 'pending';
  } else {
    // Debug log retained for the existing legacy booking flow.
    console.log('Create Booking:', body);
  }

  const isPickupBooking = (booking_type || '').toLowerCase() === 'pick up';

  // Validate required fields with detailed error messages
  if (!isLaundryRequest && !booking_type) {
    return res.status(400).json({ message: 'booking_type is required' });
  }
  if (!isLaundryRequest && !status) {
    return res.status(400).json({ message: 'status is required' });
  }
  if (!isLaundryRequest && !total_amount && total_amount !== 0) {
    return res.status(400).json({ message: 'total_amount is required' });
  }
  if (!isLaundryRequest && !shop_id) {
    return res.status(400).json({ message: 'shop_id is required' });
  }
  if (!isLaundryRequest && !service_id) {
    return res.status(400).json({ message: 'service_id is required' });
  }
  if (!isLaundryRequest && !customer_id) {
    return res.status(400).json({ message: 'customer_id is required' });
  }

  try {
    let result;

    if (isLaundryRequest) {
      const parsedShopId = Number(shop_id);
      const parsedServiceId = Number(service_id);
      const parsedCustomerId = req.authenticatedCustomerId;
      const findExistingRequest = async () => {
        const [rows] = await db.query(
          `SELECT b.booking_id, b.booking_type, b.shop_id, b.service_id, b.customer_id,
                  d.pickup_address, d.delivery_address
           FROM booking b
           LEFT JOIN delivery d ON d.booking_id = b.booking_id
           WHERE b.request_idempotency_key = ?
           LIMIT 1`,
          [idempotencyKey],
        );
        return rows[0] || null;
      };
      const ensurePickupDelivery = async bookingId => {
        if (booking_type !== 'Pick up' || !pickupDetails) return;
        await deliveryController.ensureDeliveryRecord({
          booking_id: bookingId,
          pickup_address: pickupDetails.pickup_address,
          delivery_address: pickupDetails.delivery_address,
          status: 'pending',
          customer_id: parsedCustomerId,
          shop_id: parsedShopId,
          service_id: parsedServiceId,
          io: req.app.get('io'),
        });
      };
      const respondToExistingRequest = async () => {
        const existingBooking = await findExistingRequest();
        if (!existingBooking) return false;

        if (
          Number(existingBooking.customer_id) !== parsedCustomerId ||
          Number(existingBooking.shop_id) !== parsedShopId ||
          Number(existingBooking.service_id) !== parsedServiceId ||
          existingBooking.booking_type !== booking_type ||
          (pickupDetails && (
            (existingBooking.pickup_address != null &&
             String(existingBooking.pickup_address) !== pickupDetails.pickup_address) ||
            (existingBooking.delivery_address != null &&
             String(existingBooking.delivery_address) !== pickupDetails.delivery_address)
          ))
        ) {
          res.status(409).json({ message: 'Idempotency-Key was already used for a different booking request' });
          return true;
        }

        await ensurePickupDelivery(existingBooking.booking_id);
        res.status(200).json({
          message: 'Booking request already created',
          booking_id: existingBooking.booking_id,
        });
        return true;
      };

      if (await respondToExistingRequest()) return;

      const [customerRows] = await db.query(
        'SELECT customer_id FROM customer WHERE customer_id = ? LIMIT 1',
        [parsedCustomerId],
      );
      if (!customerRows.length) {
        return res.status(404).json({ message: 'Customer not found' });
      }

      const [shopRows] = await db.query(
        'SELECT status, pickup_delivery_enabled FROM shop WHERE shop_id = ? LIMIT 1',
        [parsedShopId],
      );
      if (!shopRows.length) {
        return res.status(404).json({ message: 'Shop not found' });
      }
      if (String(shopRows[0].status || '').toLowerCase() !== 'active') {
        return res.status(409).json({ message: 'This shop is currently closed and cannot accept bookings.' });
      }
      if (
        booking_type === 'Pick up' &&
        Number(shopRows[0].pickup_delivery_enabled) !== 1
      ) {
        return res.status(409).json({ message: 'This shop does not offer pickup and delivery.' });
      }

      const [serviceRows] = await db.query(
        'SELECT service_id, status FROM services WHERE service_id = ? AND shop_id = ? LIMIT 1',
        [parsedServiceId, parsedShopId],
      );
      if (!serviceRows.length) {
        return res.status(404).json({ message: 'Selected service was not found for this shop.' });
      }
      if (
        Number(serviceRows[0].status) !== 1 &&
        String(serviceRows[0].status || '').toLowerCase() !== 'active'
      ) {
        return res.status(409).json({ message: 'The selected service is currently unavailable.' });
      }

      try {
        [result] = await db.query(
          `INSERT INTO booking
             (booking_type, status, total_amount, shop_id, service_id, customer_id, estimated_weight_kg, request_idempotency_key, price_confirmation_status)
           VALUES (?, ?, NULL, ?, ?, ?, NULL, ?, 'awaiting_shop')`,
          [
            booking_type,
            status,
            parsedShopId,
            parsedServiceId,
            parsedCustomerId,
            idempotencyKey,
          ],
        );
        await ensurePickupDelivery(result.insertId);
      } catch (insertError) {
        if (insertError.code !== 'ER_DUP_ENTRY') throw insertError;
        if (await respondToExistingRequest()) return;
        throw insertError;
      }
    } else {
      const [shopRows] = await db.query(
        'SELECT status FROM shop WHERE shop_id = ? LIMIT 1',
        [shop_id],
      );
      if (!shopRows.length) {
        return res.status(404).json({ message: 'Shop not found' });
      }
      if (String(shopRows[0].status || '').toLowerCase() !== 'active') {
        return res.status(409).json({ message: 'This shop is currently closed and cannot accept bookings.' });
      }

      const [serviceRows] = await db.query(
        'SELECT price, max_kg, price_tiers FROM services WHERE service_id = ? AND shop_id = ? LIMIT 1',
        [service_id, shop_id],
      );
      if (!serviceRows.length) {
        return res.status(404).json({ message: 'Service not found for this shop.' });
      }
      let selectedWeight = null;
      if (estimated_weight_kg !== undefined && estimated_weight_kg !== null) {
        selectedWeight = Number(estimated_weight_kg);
        const serviceMaxKg = Number(serviceRows[0].max_kg) || 9;
        if (!Number.isInteger(selectedWeight) || selectedWeight < 1 || selectedWeight > serviceMaxKg) {
          return res.status(400).json({ message: `Estimated weight must be between 1 and ${serviceMaxKg} kg for this service.` });
        }
      }

      let priceTiers = serviceRows[0].price_tiers;
      if (typeof priceTiers === 'string') {
        try {
          priceTiers = JSON.parse(priceTiers);
        } catch (error) {
          console.error('Invalid stored service price tiers:', error);
          return res.status(500).json({ message: 'Service pricing is not configured correctly.' });
        }
      }
      if (Array.isArray(priceTiers) && priceTiers.length > 0) {
        if (selectedWeight === null) {
          return res.status(400).json({ message: 'estimated_weight_kg is required for this service.' });
        }
        const matchingTier = priceTiers.find(tier => selectedWeight <= Number(tier.max_kg));
        if (!matchingTier) {
          return res.status(400).json({ message: 'No price is configured for the selected weight.' });
        }
        const pickupFee = isPickupBooking ? 40 : 0;
        const expectedTotal = Number(matchingTier.price) + pickupFee;
        if (!Number.isFinite(Number(total_amount)) || !Number.isFinite(expectedTotal)) {
          return res.status(400).json({ message: 'A valid total_amount is required.' });
        }
        if (Math.abs(Number(total_amount) - expectedTotal) > 0.01) {
          return res.status(409).json({
            message: 'The service price has changed. Please review the updated price and try again.',
            expected_total: expectedTotal,
          });
        }
      }

      const sql = `INSERT INTO booking (booking_type, status, total_amount, shop_id, service_id, customer_id, estimated_weight_kg)
                   VALUES (?, ?, ?, ?, ?, ?, ?)`;
      const params = [booking_type, status, total_amount, shop_id, service_id, customer_id, selectedWeight];

      [result] = await db.query(sql, params);
    }

    try {
      if (!isPaymentDraft) {
        // Emit socket event for real-time updates (admin + superadmin)
        const io = req.app.get('io');
        emitBookingEvent(io, shop_id, 'bookingCreated', {
          bookingId: result.insertId,
          status,
        });
        if (io && io.to) {
          try {
            io.to('role_superadmin').emit('bookingCreated', {
              shopId: shop_id,
              bookingId: result.insertId,
              status,
              at: new Date().toISOString(),
            });
          } catch (socketError) {
            console.error('Error emitting new booking event to superadmin:', socketError);
          }
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
            const notificationTitle = isLaundryRequest ? 'New Laundry Request' : 'New Service Booking';
            const message = isLaundryRequest
              ? `A new ${booking_type === 'Pick up' ? 'pickup' : 'walk-in'} laundry request has been received from ${customerDisplay}. Please review the request.`
              : `A new service booking has just been received from ${customerDisplay}! Please check the details and confirm the booking to begin processing.`;

            const { savedNotification } = await sendNotification({
              accountId: adminInfo.admin_id,
              accountType: 'admin',
              bookingId: result.insertId,
              title: notificationTitle,
              message,
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
      }
    } catch (sideEffectError) {
      if (!isLaundryRequest) throw sideEffectError;
      console.error('Booking request was created, but event/notification delivery failed:', sideEffectError);
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

// GET ALL Bookings (with payment and pickup/delivery information)
exports.getBookings = async (req, res) => {
  const { shop_id, customer_id, status } = req.query; // Optional filters

  try {
    let sql = `SELECT b.booking_id, b.booking_type,
      DATE(b.created_at) AS service_date,
      DATE(b.created_at) AS booking_date, b.created_at, b.status AS booking_status, b.total_amount, b.estimated_weight_kg, b.price_confirmation_status,
      (b.request_idempotency_key IS NOT NULL) AS is_laundry_request,
       b.shop_id, b.customer_id, s.name AS shop_name,
       s.admin_id AS shop_admin_id, s.logo AS shop_logo,
       c.first_name AS customer_first_name, c.last_name AS customer_last_name,
       c.street AS customer_street, c.zone AS customer_zone,
       c.barangay AS customer_barangay, c.city AS customer_city,
       c.street AS customer_street, c.zone AS customer_zone,
       c.barangay AS customer_barangay, c.city AS customer_city,
        p.payment_id, p.payment_method, p.amount AS payment_amount, p.status AS payment_status, p.date,
       b.service_id, srv.offers AS service_name,
      d.delivery_id, d.pickup_address AS requested_pickup_address,
      d.delivery_address AS requested_delivery_address, d.delivery_time,
      d.estimated_pickup_time, d.estimated_delivery_time, d.pickup_time,
      d.status AS delivery_status
     FROM booking b
     JOIN shop s ON b.shop_id = s.shop_id
     JOIN customer c ON b.customer_id = c.customer_id
     LEFT JOIN payment p ON p.payment_id = (
       SELECT p_latest.payment_id
       FROM payment p_latest
       WHERE p_latest.booking_id = b.booking_id
       ORDER BY p_latest.payment_id DESC
       LIMIT 1
     )
     LEFT JOIN services srv ON b.service_id = srv.service_id
    LEFT JOIN delivery d ON b.booking_id = d.booking_id
      AND (
        LOWER(REPLACE(REPLACE(b.booking_type, ' ', ''), '-', '')) LIKE '%pickup%'
        OR LOWER(REPLACE(REPLACE(b.booking_type, ' ', ''), '-', '')) LIKE '%delivery%'
      )`;

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
    whereClauses.push(`LOWER(COALESCE(b.status, '')) <> 'payment_pending'`);
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
                        DATE(b.created_at) AS service_date,
                        DATE(b.created_at) AS booking_date, b.created_at, b.status AS booking_status, b.total_amount, b.estimated_weight_kg, b.price_confirmation_status,
                        (b.request_idempotency_key IS NOT NULL) AS is_laundry_request,
                        b.shop_id, b.service_id, b.customer_id, srv.offers AS service_name, srv.description AS service_description,
                        s.name AS shop_name, s.admin_id AS shop_admin_id, s.logo AS shop_logo,
                        c.first_name AS customer_first_name, c.last_name AS customer_last_name,
                        p.payment_id, p.payment_method, p.status AS payment_status, p.date,
                        d.delivery_id, d.pickup_address AS requested_pickup_address,
                        d.delivery_address AS requested_delivery_address, d.delivery_time,
                        d.estimated_pickup_time, d.estimated_delivery_time, d.pickup_time,
                        d.status AS delivery_status
                 FROM booking b
                 JOIN shop s ON b.shop_id = s.shop_id
                 JOIN customer c ON b.customer_id = c.customer_id
                 LEFT JOIN services srv ON b.service_id = srv.service_id
                 LEFT JOIN payment p ON p.payment_id = (
                   SELECT p_latest.payment_id
                   FROM payment p_latest
                   WHERE p_latest.booking_id = b.booking_id
                   ORDER BY p_latest.payment_id DESC
                   LIMIT 1
                 )
                 LEFT JOIN delivery d ON b.booking_id = d.booking_id
                   AND (
                     LOWER(REPLACE(REPLACE(b.booking_type, ' ', ''), '-', '')) LIKE '%pickup%'
                     OR LOWER(REPLACE(REPLACE(b.booking_type, ' ', ''), '-', '')) LIKE '%delivery%'
                   )
                 WHERE b.booking_id = ?`;

    const [results] = await db.query(sql, [id]);

    if (results.length === 0) return res.status(404).json({ message: 'Booking not found' });
    res.json(results[0]);
  } catch (err) {
    console.error("DB Error (getBookingById):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

exports.submitBookingPriceConfirmation = async (req, res) => {
  const bookingId = Number(req.params.id);
  const adminId = req.authenticatedAdminId;
  const {
    service_id,
    estimated_weight_kg,
    total_amount,
    start_processing,
  } = req.body || {};
  const weight = Number(estimated_weight_kg);
  const amount = Number(total_amount);

  if (!Number.isSafeInteger(bookingId) || bookingId <= 0) {
    return res.status(400).json({ message: 'A valid booking ID is required' });
  }
  if (!Number.isSafeInteger(adminId) || adminId <= 0) {
    return res.status(401).json({ message: 'A valid staff login is required.' });
  }
  if (!Number.isSafeInteger(weight) || weight <= 0) {
    return res.status(400).json({ message: 'estimated_weight_kg must be a positive whole number' });
  }
  if (
    !Number.isFinite(amount) ||
    amount <= 0 ||
    amount > 99999.99 ||
    Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-8
  ) {
    return res.status(400).json({ message: 'total_amount must be a positive amount with at most two decimal places' });
  }

  try {
    const [bookingRows] = await db.query(
      `SELECT b.booking_id, b.shop_id, b.customer_id, b.booking_type, b.status, b.service_id,
              b.estimated_weight_kg, b.total_amount, b.price_confirmation_status,
              d.status AS delivery_status, d.estimated_pickup_time,
              d.estimated_delivery_time,
              (SELECT p.payment_id FROM payment p
               WHERE p.booking_id = b.booking_id ORDER BY p.payment_id DESC LIMIT 1) AS payment_id,
              (SELECT p.payment_method FROM payment p
               WHERE p.booking_id = b.booking_id ORDER BY p.payment_id DESC LIMIT 1) AS payment_method,
              (SELECT p.status FROM payment p
               WHERE p.booking_id = b.booking_id ORDER BY p.payment_id DESC LIMIT 1) AS payment_status
       FROM booking b
       INNER JOIN shop s ON s.shop_id = b.shop_id
       LEFT JOIN delivery d ON d.booking_id = b.booking_id
       WHERE b.booking_id = ?
         AND s.admin_id = ?
         AND b.request_idempotency_key IS NOT NULL
       LIMIT 1`,
      [bookingId, adminId],
    );
    if (!bookingRows.length) {
      return res.status(404).json({ message: 'Laundry request not found for this shop' });
    }

    const booking = bookingRows[0];
    const serviceId = Number(booking.service_id);
    if (!Number.isSafeInteger(serviceId) || serviceId <= 0) {
      return res.status(409).json({ message: 'The customer-selected service is missing from this request' });
    }
    const isPickupBooking = String(booking.booking_type || '').toLowerCase().includes('pick');
    const shouldStartProcessing = isPickupBooking && start_processing === true;
    if (String(booking.payment_status || '').toLowerCase() === 'paid') {
      return res.status(409).json({ message: 'This request already has a completed payment.' });
    }
    if (service_id !== undefined && Number(service_id) !== serviceId) {
      return res.status(409).json({ message: 'The price confirmation must use the service selected by the customer' });
    }
    if (isPickupBooking && req.body?.estimated_pickup_time !== undefined) {
      return res.status(400).json({ message: 'Estimated pickup time is set when the shop confirms the request' });
    }
    if (
      isPickupBooking &&
      (String(booking.status || '').toLowerCase() !== 'confirmed' ||
       String(booking.delivery_status || '').toLowerCase() !== 'at_shop')
    ) {
      return res.status(409).json({ message: 'Pickup requests can receive a final amount after the laundry arrives at the shop' });
    }
    if (
      !isPickupBooking &&
      String(booking.status || '').toLowerCase() !== 'processing' &&
      !isPriceConfirmationReady(booking.price_confirmation_status)
    ) {
      return res.status(409).json({ message: 'Walk-in requests can receive a total amount after processing starts' });
    }
    if (req.body?.estimated_delivery_time !== undefined) {
      return res.status(400).json({
        message: 'Estimated delivery time is set when the pickup is marked ready for delivery',
      });
    }
    if (isPriceConfirmationReady(booking.price_confirmation_status)) {
      if (
        Number(booking.service_id) === serviceId &&
        Number(booking.estimated_weight_kg) === weight &&
        Math.abs(Number(booking.total_amount) - amount) <= 0.001
      ) {
        return res.status(200).json({
          message: 'Final amount already confirmed',
          booking_id: bookingId,
          status: booking.status,
          price_confirmation_status: booking.price_confirmation_status,
          service_id: serviceId,
          estimated_weight_kg: weight,
          total_amount: Number(booking.total_amount),
          estimated_pickup_time: booking.estimated_pickup_time,
          estimated_delivery_time: booking.estimated_delivery_time,
        });
      }
      return res.status(409).json({ message: 'A final amount has already been confirmed for this request' });
    }

    const [serviceRows] = await db.query(
      `SELECT service_id, shop_id, status, price, max_kg, price_tiers
       FROM services
       WHERE service_id = ? AND shop_id = ?
       LIMIT 1`,
      [serviceId, booking.shop_id],
    );
    if (!serviceRows.length) {
      return res.status(400).json({ message: 'The selected service does not belong to this shop' });
    }

    const service = serviceRows[0];
    if (Number(service.status) !== 1 && String(service.status || '').toLowerCase() !== 'active') {
      return res.status(409).json({ message: 'The selected service is not active' });
    }
    const maxKg = Number(service.max_kg) || 9;
    if (weight > maxKg) {
      return res.status(400).json({ message: `estimated_weight_kg cannot exceed ${maxKg} kg for this service` });
    }

    let priceTiers = service.price_tiers;
    if (typeof priceTiers === 'string') {
      try {
        priceTiers = JSON.parse(priceTiers);
      } catch (error) {
        console.error('Invalid stored service price tiers:', error);
        return res.status(500).json({ message: 'Service pricing is not configured correctly.' });
      }
    }
    if (Array.isArray(priceTiers) && priceTiers.length > 0) {
      const matchingTier = priceTiers.find(tier => weight <= Number(tier.max_kg));
      if (!matchingTier) {
        return res.status(400).json({ message: 'No price is configured for the selected weight.' });
      }
      const pickupFee = isPickupBooking ? 40 : 0;
      const expectedAmount = Number(matchingTier.price) + pickupFee;
      if (!Number.isFinite(expectedAmount)) {
        return res.status(500).json({ message: 'Service pricing is not configured correctly.' });
      }
      if (Math.abs(amount - expectedAmount) > 0.01) {
        return res.status(409).json({
          message: 'The confirmed amount does not match the configured service price.',
          expected_total: expectedAmount,
        });
      }
    }

    const connection = await db.getConnection();
    let updateResult;
    let paymentUpdate;
    try {
      await connection.beginTransaction();
      [updateResult] = isPickupBooking
        ? await connection.query(
          `UPDATE booking b
           INNER JOIN delivery d ON d.booking_id = b.booking_id
          SET b.status = CASE WHEN ? = 1 THEN 'processing' ELSE b.status END,
               b.estimated_weight_kg = ?, b.total_amount = ?,
               b.price_confirmation_status = 'confirmed'
           WHERE b.booking_id = ?
             AND b.status = 'confirmed'
             AND d.status = 'at_shop'
             AND b.request_idempotency_key IS NOT NULL
             AND (b.price_confirmation_status IS NULL OR b.price_confirmation_status IN ('awaiting_shop', 'declined'))`,
          [shouldStartProcessing ? 1 : 0, weight, amount, bookingId],
        )
        : await connection.query(
          `UPDATE booking
           SET estimated_weight_kg = ?, total_amount = ?,
               price_confirmation_status = 'confirmed'
           WHERE booking_id = ?
             AND status = 'processing'
             AND request_idempotency_key IS NOT NULL
             AND (price_confirmation_status IS NULL OR price_confirmation_status IN ('awaiting_shop', 'declined'))`,
          [weight, amount, bookingId],
        );

      if (updateResult.affectedRows > 0 && booking.payment_id) {
        [paymentUpdate] = await connection.query(
          `UPDATE payment
           SET amount = ?, service_id = ?
           WHERE booking_id = ? AND LOWER(COALESCE(status, '')) = 'pending'`,
          [amount, serviceId, bookingId],
        );
        if (!paymentUpdate.affectedRows) {
          throw new Error('Pending payment record was not updated with the confirmed final amount.');
        }
      }
      await connection.commit();
    } catch (error) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Failed to roll back the final amount transaction:', rollbackError);
      }
      throw error;
    } finally {
      connection.release();
    }

    if (updateResult.affectedRows === 0) {
      const [currentRows] = await db.query(
        `SELECT b.price_confirmation_status, b.service_id, b.estimated_weight_kg, b.total_amount,
                d.estimated_pickup_time, d.estimated_delivery_time
         FROM booking b
         LEFT JOIN delivery d ON d.booking_id = b.booking_id
         WHERE b.booking_id = ? LIMIT 1`,
        [bookingId],
      );
      const current = currentRows[0];
      if (
        isPriceConfirmationReady(current?.price_confirmation_status) &&
        Number(current.service_id) === serviceId &&
        Number(current.estimated_weight_kg) === weight &&
        Math.abs(Number(current.total_amount) - amount) <= 0.001
      ) {
        return res.status(200).json({
          message: 'Final amount already confirmed',
          booking_id: bookingId,
          status: booking.status,
          price_confirmation_status: current.price_confirmation_status,
          service_id: serviceId,
          estimated_weight_kg: weight,
          total_amount: amount,
          estimated_pickup_time: current.estimated_pickup_time,
          estimated_delivery_time: current.estimated_delivery_time,
        });
      }
      return res.status(409).json({ message: 'A final amount can no longer be confirmed for this request' });
    }

    try {
      const io = req.app.get('io');
      await emitBookingEvent(io, booking.shop_id, 'bookingUpdated', {
        bookingId,
        status: shouldStartProcessing ? 'processing' : booking.status,
        price_confirmation_status: 'confirmed',
      });
      if (io && io.to) {
        io.to(`user_customer_${booking.customer_id}`).emit('bookingUpdated', {
          bookingId,
          status: shouldStartProcessing ? 'processing' : booking.status,
          price_confirmation_status: 'confirmed',
          service_id: serviceId,
          estimated_weight_kg: weight,
          total_amount: amount,
          estimated_pickup_time: booking.estimated_pickup_time,
          estimated_delivery_time: booking.estimated_delivery_time,
        });
      }
      const { savedNotification } = await sendNotification({
        accountId: booking.customer_id,
        accountType: 'customer',
        bookingId,
        title: 'Laundry total confirmed',
        message: isPickupBooking
          ? `The shop processed your laundry and confirmed the total amount of ₱${amount.toFixed(2)}. Payment options will be available after delivery.`
          : `The shop processed your laundry and confirmed the total amount of ₱${amount.toFixed(2)}. It is ready for payment.`,
      });
      if (io && savedNotification) {
        io.to(`user_customer_${booking.customer_id}`).emit('newNotification', savedNotification);
      }
    } catch (notificationError) {
      console.error('Final laundry amount was saved, but customer notification delivery failed:', notificationError);
    }

    return res.status(201).json({
      message: 'Final laundry amount confirmed successfully',
      booking_id: bookingId,
      status: shouldStartProcessing ? 'processing' : booking.status,
      price_confirmation_status: 'confirmed',
      service_id: serviceId,
      estimated_weight_kg: weight,
      total_amount: amount,
      estimated_pickup_time: booking.estimated_pickup_time,
      estimated_delivery_time: booking.estimated_delivery_time,
    });
  } catch (err) {
    console.error('Confirm final laundry amount error:', err);
    return res.status(500).json({ message: 'Database error', error: err.message });
  }
};

exports.selectLaundryRequestPaymentMethod = async (req, res) => {
  const bookingId = Number(req.params.id);
  const customerId = req.authenticatedCustomerId;
  const paymentMethod = String(req.body?.payment_method || '').trim().toLowerCase();

  if (!Number.isSafeInteger(bookingId) || bookingId <= 0) {
    return res.status(400).json({ message: 'A valid booking ID is required' });
  }
  if (!Number.isSafeInteger(customerId) || customerId <= 0) {
    return res.status(401).json({ message: 'A valid customer login is required.' });
  }
  if (!['cash', 'online', 'qrph'].includes(paymentMethod)) {
    return res.status(400).json({ message: 'payment_method must be cash, online, or qrph' });
  }

  let connection;
  let booking;
  let paymentId;
  let storedPaymentMethod;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();

    const [bookingRows] = await connection.query(
      `SELECT b.booking_id, b.customer_id, b.shop_id, b.service_id, b.booking_type, b.status,
              b.total_amount, b.price_confirmation_status, b.request_idempotency_key,
              d.status AS delivery_status
       FROM booking b
       LEFT JOIN delivery d ON d.booking_id = b.booking_id
       WHERE b.booking_id = ?
         AND b.customer_id = ?
       LIMIT 1
       FOR UPDATE`,
      [bookingId, customerId],
    );
    if (!bookingRows.length) {
      await connection.rollback();
      return res.status(404).json({ message: 'Laundry request not found' });
    }

    booking = bookingRows[0];
    const normalizedBookingType = String(booking.booking_type || '')
      .trim()
      .toLowerCase()
      .replace(/[\s-]/g, '');
    const isPickupBooking = normalizedBookingType.includes('pickup') ||
      normalizedBookingType.includes('delivery');
    if (!isPickupBooking && String(booking.booking_type || '').trim().toLowerCase() !== 'walk in') {
      await connection.rollback();
      return res.status(409).json({ message: 'Payment method selection is not available for this request' });
    }
    if (!isPriceConfirmationReady(booking.price_confirmation_status) || !Number(booking.total_amount)) {
      await connection.rollback();
      return res.status(409).json({ message: 'Choose a payment method after the shop confirms the total amount' });
    }
    if (isPickupBooking) {
      const deliveryStatus = String(booking.delivery_status || '').toLowerCase();
      const allowedBeforeDelivery = ['cash', 'qrph'].includes(paymentMethod) &&
        deliveryStatus === 'out_for_delivery';
      if (deliveryStatus !== 'delivered' && !allowedBeforeDelivery) {
        await connection.rollback();
        return res.status(409).json({
          message: 'Choose COD or QR Ph while the laundry is on the way. GCash is available after delivery.',
        });
      }
    }
    if (
      !isPickupBooking &&
      !['processing', 'completed'].includes(String(booking.status || '').toLowerCase())
    ) {
      await connection.rollback();
      return res.status(409).json({ message: 'Payment method selection is available after laundry processing starts' });
    }

    const [paymentRows] = await connection.query(
      `SELECT payment_id, payment_method, status, paymongo_payment_id
       FROM payment
       WHERE booking_id = ?
       ORDER BY payment_id DESC
       LIMIT 1
       FOR UPDATE`,
      [bookingId],
    );
    const payment = paymentRows[0];
    storedPaymentMethod = isPickupBooking && paymentMethod === 'cash'
      ? 'cod'
      : paymentMethod;
    if (
      isPickupBooking &&
      String(booking.delivery_status || '').toLowerCase() === 'out_for_delivery' &&
      storedPaymentMethod === 'online'
    ) {
      await connection.rollback();
      return res.status(409).json({ message: 'GCash selection remains available after delivery; choose COD or QR Ph while the laundry is on the way.' });
    }
    if (payment) {
      const currentStatus = String(payment.status || '').trim().toLowerCase();
      if (['paid', 'success', 'succeeded', 'completed'].includes(currentStatus)) {
        await connection.rollback();
        return res.status(409).json({ message: 'Payment has already been completed and cannot be changed' });
      }
      if (
        String(payment.payment_method || '').toLowerCase() === 'gcash' &&
        String(payment.payment_method || '').toLowerCase() !== storedPaymentMethod &&
        currentStatus === 'pending' &&
        payment.paymongo_payment_id
      ) {
        await connection.rollback();
        return res.status(409).json({ message: 'An active GCash checkout must be completed or canceled before changing the payment method.' });
      }
      if (
        String(payment.payment_method || '').toLowerCase() === 'qrph' &&
        String(payment.payment_method || '').toLowerCase() !== storedPaymentMethod &&
        payment.paymongo_payment_id
      ) {
        const qrPhStatus = await paymongoService.getQrPhPayment(payment.paymongo_payment_id);
        if (!qrPhStatus.success) {
          await connection.rollback();
          return res.status(502).json({
            message: qrPhStatus.error || 'Unable to verify the current QR Ph payment before changing the method.',
          });
        }
        if (qrPhStatus.data.status === 'paid') {
          await connection.rollback();
          return res.status(409).json({ message: 'This QR Ph payment is already paid and cannot be changed.' });
        }
        if (qrPhStatus.data.status === 'pending') {
          const cancellation = await paymongoService.cancelQrPhPayment(payment.paymongo_payment_id);
          if (!cancellation.success || cancellation.data?.status !== 'failed') {
            const latestQrPhStatus = await paymongoService.getQrPhPayment(payment.paymongo_payment_id);
            if (!latestQrPhStatus.success) {
              await connection.rollback();
              return res.status(502).json({
                message: latestQrPhStatus.error || 'Unable to confirm the QR Ph payment status after cancellation.',
              });
            }
            if (latestQrPhStatus.data.status === 'paid') {
              await connection.rollback();
              return res.status(409).json({ message: 'This QR Ph payment was paid and cannot be changed.' });
            }
            if (!['failed', 'expired'].includes(latestQrPhStatus.data.status)) {
              await connection.rollback();
              return res.status(409).json({
                message: cancellation.error ||
                  'PayMongo could not cancel the active QR Ph code. Wait until it expires before changing payment method.',
              });
            }
          }
        } else if (!['failed', 'expired'].includes(qrPhStatus.data.status)) {
          await connection.rollback();
          return res.status(409).json({
            message: 'The current QR Ph code is still active. Payment method can be changed after it expires or fails.',
          });
        }
      }
      if (currentStatus && !['pending', 'failed', 'cancelled'].includes(currentStatus)) {
        await connection.rollback();
        return res.status(409).json({ message: 'This payment can no longer be changed' });
      }

      paymentId = payment.payment_id;
      if (String(payment.payment_method || '').toLowerCase() !== storedPaymentMethod) {
        await connection.query(
          `UPDATE payment
           SET payment_method = ?, amount = ?, service_id = ?, status = 'pending',
               paymongo_payment_id = NULL
           WHERE payment_id = ?`,
          [storedPaymentMethod, booking.total_amount, booking.service_id, paymentId],
        );
      }
    } else {
      const [insertResult] = await connection.query(
        `INSERT INTO payment
           (booking_id, customer_id, shop_id, service_id, payment_method, amount, status, date)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', NOW())`,
        [
          bookingId,
          customerId,
          booking.shop_id,
          booking.service_id,
          storedPaymentMethod,
          booking.total_amount,
        ],
      );
      paymentId = insertResult.insertId;
    }

    await connection.commit();
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Failed to roll back laundry-request payment method selection:', rollbackError);
      }
    }
    console.error('Select laundry-request payment method error:', error);
    return res.status(500).json({ message: 'Unable to save the payment method' });
  } finally {
    if (connection) connection.release();
  }

  try {
    const io = req.app.get('io');
    const paymentUpdate = {
      bookingId,
      payment_id: paymentId,
      payment_method: storedPaymentMethod,
      payment_status: 'pending',
      total_amount: Number(booking.total_amount),
    };
    await emitBookingEvent(io, booking.shop_id, 'bookingUpdated', paymentUpdate);
    if (io && io.to) {
      io.to(`user_customer_${customerId}`).emit('bookingUpdated', paymentUpdate);
    }
  } catch (notificationError) {
    console.error('Laundry-request payment method was saved, but update delivery failed:', notificationError);
  }

  return res.status(200).json({
    message: 'Payment method saved',
    booking_id: bookingId,
    payment_id: paymentId,
    payment_method: storedPaymentMethod,
    payment_status: 'pending',
    total_amount: Number(booking.total_amount),
  });
};

exports.selectWalkInPaymentMethod = exports.selectLaundryRequestPaymentMethod;

exports.confirmPickupRequest = async (req, res) => {
  const bookingId = Number(req.params.id);
  const adminId = req.authenticatedAdminId;
  const rawTime = req.body?.estimated_pickup_time;
  const estimatedPickupTime =
    typeof rawTime === 'string' &&
    /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(rawTime)
      ? rawTime.length === 5 ? `${rawTime}:00` : rawTime
      : null;

  if (!Number.isSafeInteger(bookingId) || bookingId <= 0) {
    return res.status(400).json({ message: 'A valid booking ID is required' });
  }
  if (!Number.isSafeInteger(adminId) || adminId <= 0) {
    return res.status(401).json({ message: 'A valid staff login is required.' });
  }
  if (!estimatedPickupTime) {
    return res.status(400).json({ message: 'A valid estimated pickup time is required (HH:MM)' });
  }

  let connection;
  let booking;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();
    const [bookingRows] = await connection.query(
      `SELECT b.booking_id, b.shop_id, b.customer_id, b.booking_type, b.status,
              b.request_idempotency_key, d.delivery_id, d.status AS delivery_status,
              d.estimated_pickup_time
       FROM booking b
       INNER JOIN shop s ON s.shop_id = b.shop_id
       LEFT JOIN delivery d ON d.booking_id = b.booking_id
       WHERE b.booking_id = ? AND s.admin_id = ?
       LIMIT 1
       FOR UPDATE`,
      [bookingId, adminId],
    );
    if (!bookingRows.length || !bookingRows[0].request_idempotency_key ||
        !String(bookingRows[0].booking_type || '').toLowerCase().includes('pick')) {
      await connection.rollback();
      return res.status(404).json({ message: 'Pickup laundry request not found for this shop' });
    }

    booking = bookingRows[0];
    if (
      String(booking.status || '').toLowerCase() === 'confirmed' &&
      String(booking.estimated_pickup_time || '') === estimatedPickupTime
    ) {
      await connection.commit();
      return res.status(200).json({
        message: 'Pickup request already confirmed',
        booking_id: bookingId,
        status: 'confirmed',
        estimated_pickup_time: estimatedPickupTime,
      });
    }
    if (String(booking.status || '').toLowerCase() !== 'pending') {
      await connection.rollback();
      return res.status(409).json({ message: 'Only pending pickup requests can be confirmed' });
    }
    if (!booking.delivery_id) {
      await connection.rollback();
      return res.status(409).json({ message: 'Pickup addresses are missing from the delivery record' });
    }

    const [bookingUpdate] = await connection.query(
      `UPDATE booking
       SET status = 'confirmed'
       WHERE booking_id = ? AND status = 'pending' AND request_idempotency_key IS NOT NULL`,
      [bookingId],
    );
    if (!bookingUpdate.affectedRows) {
      await connection.rollback();
      return res.status(409).json({ message: 'This pickup request can no longer be confirmed' });
    }
    await connection.query(
      `UPDATE delivery
       SET estimated_pickup_time = ?
       WHERE delivery_id = ? AND booking_id = ?`,
      [estimatedPickupTime, booking.delivery_id, bookingId],
    );
    await connection.commit();
  } catch (error) {
    try { await connection.rollback(); } catch (_) { /* rollback best effort */ }
    console.error('Confirm pickup request error:', error);
    return res.status(500).json({ message: 'Unable to confirm pickup request' });
  } finally {
    if (connection) connection.release();
  }

  try {
    const io = req.app.get('io');
    await emitBookingEvent(io, booking.shop_id, 'bookingUpdated', {
      bookingId,
      status: 'confirmed',
    });
    if (io?.to) {
      io.to(`user_customer_${booking.customer_id}`).emit('bookingUpdated', {
        bookingId,
        status: 'confirmed',
        estimated_pickup_time: estimatedPickupTime,
      });
    }
    const { savedNotification } = await sendNotification({
      accountId: booking.customer_id,
      accountType: 'customer',
      bookingId,
      title: 'Pickup request confirmed',
      message: `The shop confirmed your pickup request. Estimated pickup time: ${estimatedPickupTime.slice(0, 5)}.`,
    });
    if (savedNotification && io?.to) {
      io.to(`user_customer_${booking.customer_id}`).emit('newNotification', savedNotification);
    }
  } catch (notificationError) {
    console.error('Pickup was confirmed, but customer notification delivery failed:', notificationError);
  }

  return res.status(200).json({
    message: 'Pickup request confirmed',
    booking_id: bookingId,
    status: 'confirmed',
    estimated_pickup_time: estimatedPickupTime,
  });
};

// UPDATE Booking Status Only (Cancel booking triggers notification; Confirm triggers customer notification for walk-in)
exports.updateBookingStatus = async (req, res) => {
  const { id } = req.params;
  const { status, customer_id: requestedCustomerId, decline_reason: declineReason, decline_message: declineMessage } = req.body;

  if (!status) {
    return res.status(400).json({ message: 'Status is required' });
  }

  try {
    const currentBooking = await getBookingStatusContext(id);
    if (!currentBooking) return res.status(404).json({ message: 'Booking not found' });
    const requestedStatus = String(status).toLowerCase();
    const previousBookingStatus = String(currentBooking.status || '').toLowerCase();
    if (requestedStatus === 'completed') {
      const adminId = req.authenticatedAdminId;
      if (!Number.isSafeInteger(adminId) || adminId <= 0) {
        return res.status(401).json({ message: 'A valid staff login is required.' });
      }
      if (Number(currentBooking.admin_id) !== adminId) {
        return res.status(403).json({ message: 'You are not authorized to complete this shop booking.' });
      }
      const completionError = getBookingCompletionError(currentBooking);
      if (completionError) return res.status(409).json({ message: completionError });
    }
    if (
      currentBooking.request_idempotency_key &&
      String(currentBooking.booking_type || '').toLowerCase().includes('pick') &&
      requestedStatus === 'confirmed'
    ) {
      return res.status(409).json({ message: 'Pickup requests must be confirmed with an estimated pickup time.' });
    }
    if (
      currentBooking.request_idempotency_key &&
      !String(currentBooking.booking_type || '').toLowerCase().includes('pick') &&
      requestedStatus === 'confirmed' &&
      !['pending', 'confirmed'].includes(previousBookingStatus)
    ) {
      return res.status(409).json({ message: 'Only pending walk-in laundry requests can be confirmed.' });
    }
    if (
      currentBooking.request_idempotency_key &&
      requestedStatus === 'processing' &&
      (
        !['confirmed', 'processing'].includes(previousBookingStatus) ||
        (
          String(currentBooking.booking_type || '').toLowerCase().includes('pick') &&
          (
            !isPriceConfirmationReady(currentBooking.price_confirmation_status) ||
            String(currentBooking.delivery_status || '').toLowerCase() !== 'at_shop'
          )
        )
      )
    ) {
      return res.status(409).json({
        message: String(currentBooking.booking_type || '').toLowerCase().includes('pick')
          ? 'Pickup laundry must be confirmed, have its total amount confirmed, and arrive at the shop before processing can start.'
          : 'The walk-in request must be confirmed before processing can start.',
      });
    }

    if (requestedStatus === 'cancelled' && requestedCustomerId != null) {
      if (Number(currentBooking.customer_id) !== Number(requestedCustomerId)) {
        return res.status(403).json({ message: 'You are not authorized to cancel this booking' });
      }
      if (previousBookingStatus !== 'pending') {
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
    SELECT b.shop_id, b.booking_type, b.customer_id, DATE(b.created_at) AS request_date, s.name AS shop_name
    FROM booking b
    LEFT JOIN shop s ON s.shop_id = b.shop_id
    WHERE b.booking_id = ?
  `, [id]);
  const shopId = shopRows && shopRows[0] ? shopRows[0].shop_id : null;
  const bookingType = shopRows && shopRows[0] ? (shopRows[0].booking_type || '') : '';
  const customerId = shopRows && shopRows[0] ? shopRows[0].customer_id : null;
  const requestDate = shopRows && shopRows[0] ? shopRows[0].request_date : null;
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
          // Format the request date in PH locale (fallback to ISO if invalid)
          let formattedDate = '';
          try {
            const d = requestDate ? new Date(requestDate) : null;
            formattedDate = d && !isNaN(d.getTime())
              ? d.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' })
              : '';
          } catch (_) { formattedDate = ''; }
          const title = 'Walk-in Booking Confirmed';
          const message = `Your walk-in booking has been confirmed${formattedDate ? ` (request received ${formattedDate})` : ''}. Please bring your laundry during the shop's operating hours.`;

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
    });
  } catch (err) {
    console.error('Update booking status error:', err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

// UPDATE Booking
exports.updateBooking = async (req, res) => {
  const { id } = req.params;
  const { booking_type, status, total_amount, shop_id, service_id, customer_id } = req.body;

  if (!booking_type || !status || !total_amount || !shop_id || !service_id || !customer_id) {
    return res.status(400).json({ message: 'All fields are required' });
  }

  try {
    const adminId = req.authenticatedAdminId;
    if (!Number.isSafeInteger(adminId) || adminId <= 0) {
      return res.status(401).json({ message: 'A valid staff login is required.' });
    }
    const currentBooking = await getBookingStatusContext(id);
    if (!currentBooking) return res.status(404).json({ message: 'Booking not found' });
    if (Number(currentBooking.admin_id) !== adminId) {
      return res.status(403).json({ message: 'You are not authorized to update this shop booking.' });
    }
    if (Number(shop_id) !== Number(currentBooking.shop_id)) {
      return res.status(409).json({ message: 'A booking cannot be transferred to another shop.' });
    }
    if (String(status).toLowerCase() === 'completed') {
      const completionError = getBookingCompletionError(currentBooking);
      if (completionError) return res.status(409).json({ message: completionError });
    }

    const sql = `UPDATE booking
                 SET booking_type=?, status=?, total_amount=?,
                     shop_id=?, service_id=?, customer_id=?
                 WHERE booking_id=?`;

    const [result] = await db.query(sql, [booking_type, status, total_amount, shop_id, service_id, customer_id, id]);

    if (result.affectedRows === 0) return res.status(404).json({ message: 'Booking not found' });

    // Emit update event
    if (shop_id) {
      const io = req.app.get('io');
      emitBookingEvent(io, shop_id, 'bookingUpdated', {
        bookingId: Number(id),
        status,
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
