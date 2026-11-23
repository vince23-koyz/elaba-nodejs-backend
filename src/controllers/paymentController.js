// src/controllers/paymentController.js
const db = require("../config/db");
const crypto = require('crypto');
const { sendNotification } = require('../service/notificationService');
const deliveryController = require('./deliveryController');

const SHOP_CONFIRMED_PRICE_STATUSES = new Set(['confirmed', 'awaiting_customer', 'accepted', 'declined']);

function isShopConfirmedPrice(status) {
  return SHOP_CONFIRMED_PRICE_STATUSES.has(String(status || '').toLowerCase());
}

// Get all payments
exports.getPayments = async (req, res) => {
  try {
    const [result] = await db.query("SELECT * FROM payment");
    res.json(result);
  } catch (err) {
    console.error("DB Error (getPayments):", err);
    res.status(500).json({ message: "Database error", error: err.message });
  }
};

// Get payment by ID
exports.getPaymentById = async (req, res) => {
  const { id } = req.params;

  try {
    const [result] = await db.query("SELECT * FROM payment WHERE payment_id = ?", [id]);

    if (result.length === 0) return res.status(404).json({ message: "Payment not found" });
    res.json(result[0]);
  } catch (err) {
    console.error("DB Error (getPaymentById):", err);
    res.status(500).json({ message: "Database error", error: err.message });
  }
};

// CREATE Payment (updated to include amount and optional transaction_id)
exports.createPayment = async (req, res) => {
  const {
    booking_id,
    customer_id,
    shop_id,
    service_id,
    payment_method,
    status,
    amount,
    transaction_id,
    paymongo_payment_id,
    payment_intent_id
  } = req.body;

  if (!booking_id || !customer_id || !shop_id || !service_id || !payment_method) {
    return res.status(400).json({ message: "booking_id, customer_id, shop_id, service_id and payment_method are required" });
  }

  try {
    const [bookingRows] = await db.query(
      `SELECT b.booking_id, b.customer_id, b.shop_id, b.service_id, b.booking_type,
            b.total_amount, b.request_idempotency_key, b.price_confirmation_status,
            d.status AS delivery_status
       FROM booking b
       LEFT JOIN delivery d ON d.booking_id = b.booking_id
       WHERE b.booking_id = ?
       LIMIT 1`,
      [booking_id]
    );
    const booking = bookingRows[0];
    if (booking && booking.request_idempotency_key) {
      return res.status(409).json({
        message: 'Laundry request payments must be selected through the authenticated payment flow.',
      });
    }
    if (booking) {
      if (!isShopConfirmedPrice(booking.price_confirmation_status)) {
        return res.status(409).json({ message: 'The shop must confirm the total amount before payment.' });
      }
      const requestedAmount = amount == null ? Number(booking.total_amount) : Number(amount);
      if (
        Number(customer_id) !== Number(booking.customer_id) ||
        Number(shop_id) !== Number(booking.shop_id) ||
        Number(service_id) !== Number(booking.service_id) ||
        !Number.isFinite(requestedAmount) ||
        Math.abs(requestedAmount - Number(booking.total_amount)) > 0.01
      ) {
        return res.status(409).json({ message: 'Payment details do not match the shop-confirmed total amount.' });
      }
      if (payment.shop_id) {
        try {
          const [adminRows] = await db.query(
            `SELECT admin_id FROM shop WHERE shop_id = ? LIMIT 1`,
            [payment.shop_id],
          );
          const adminId = adminRows[0]?.admin_id;
          if (adminId) {
            io.to(`user_admin_${adminId}`).emit('bookingUpdated', payload);
          }
        } catch (shopNotificationError) {
          console.error('Failed to emit payment update to shop staff:', shopNotificationError);
        }
      }
    }

    let resolvedPaymongoPaymentId = paymongo_payment_id || null;
    if (!resolvedPaymongoPaymentId && String(payment_method).toLowerCase() === 'gcash' && payment_intent_id) {
      resolvedPaymongoPaymentId = await paymongoService.resolvePaymentId(payment_intent_id);
    }
    const isPaidStatus = ['paid', 'success', 'succeeded', 'completed'].includes(String(status || '').toLowerCase());
    const providerReference = resolvedPaymongoPaymentId || payment_intent_id || null;
    console.log(`[Payment] Creating ${payment_method} record booking=${booking_id} amount=${amount ?? 'fallback'} paymongo=${providerReference || 'null'} status=${isPaidStatus ? 'paid' : 'pending'}`);
  // payment status vocabulary: 'pending' | 'paid'
  const normalizedStatus = (status || 'pending').toString().toLowerCase();
  const statusNorm = ['paid', 'success', 'succeeded', 'completed'].includes(normalizedStatus) ? 'paid' : 'pending';
    const sql = `INSERT INTO payment
      (booking_id, customer_id, shop_id, service_id, payment_method, amount, status, date, transaction_id, paymongo_payment_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)`;

    let amt = amount != null ? Number(amount) : null;
    if (!Number.isFinite(amt) || amt <= 0) {
      const [bookingRows] = await db.query(
        'SELECT total_amount FROM booking WHERE booking_id = ? LIMIT 1',
        [booking_id]
      );
      const bookingAmount = bookingRows?.[0]?.total_amount;
      amt = bookingAmount != null ? Number(bookingAmount) : null;
    }
    const txId = transaction_id != null ? Number(transaction_id) : null;

    const [result] = await db.query(sql, [
      booking_id, customer_id, shop_id, service_id, payment_method, amt, statusNorm, txId, providerReference
    ]);

    res.status(201).json({
      message: "Payment created successfully",
      payment_id: result.insertId,
    });
  } catch (err) {
    console.error("Payment DB Error:", err);
    res.status(500).json({ message: "Database error", error: err.message });
  }
};

// Update payment status
exports.updatePaymentStatus = async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  const adminId = req.authenticatedAdminId;

  if (!status) return res.status(400).json({ message: "Status is required" });
  if (!Number.isSafeInteger(adminId) || adminId <= 0) {
    return res.status(401).json({ message: 'A valid staff login is required.' });
  }

  try {
  // normalize status to only 'paid' | 'pending'
  const normalizedStatus = (status || '').toString().toLowerCase();
  const nextStatus = ['paid', 'success', 'succeeded', 'completed'].includes(normalizedStatus) ? 'paid' : 'pending';
    const [priceConfirmationRows] = await db.query(
      `SELECT p.payment_id, p.amount AS payment_amount, p.shop_id AS payment_shop_id,
              p.payment_method, b.booking_id, b.booking_type, b.shop_id,
              b.total_amount, b.request_idempotency_key,
              b.price_confirmation_status, d.status AS delivery_status, s.admin_id
       FROM payment p
       LEFT JOIN booking b ON b.booking_id = p.booking_id
       LEFT JOIN shop s ON s.shop_id = b.shop_id
       LEFT JOIN delivery d ON d.booking_id = b.booking_id
       WHERE p.payment_id = ?
       LIMIT 1`,
      [id]
    );
    const payment = priceConfirmationRows[0];
    if (!payment) {
      return res.status(404).json({ message: "Payment not found" });
    }
    if (Number(payment.admin_id) !== adminId || Number(payment.payment_shop_id) !== Number(payment.shop_id)) {
      return res.status(403).json({ message: 'You are not authorized to update this shop payment.' });
    }
    if (String(payment.payment_method || '').toLowerCase() === 'qrph') {
      return res.status(409).json({ message: 'QR Ph payment status can only be updated after PayMongo verification.' });
    }
    if (
      nextStatus === 'paid' &&
      payment.request_idempotency_key &&
      (
        !isShopConfirmedPrice(payment.price_confirmation_status) ||
        !Number.isFinite(Number(payment.total_amount)) ||
        Number(payment.total_amount) <= 0 ||
        Math.abs(Number(payment.payment_amount) - Number(payment.total_amount)) > 0.01
      )
    ) {
      return res.status(409).json({ message: 'The shop must confirm the total amount and payment amount before payment can be completed.' });
    }
    if (
      nextStatus === 'paid' &&
      String(payment.booking_type || '').toLowerCase().includes('pick') &&
      String(payment.payment_method || '').toLowerCase() === 'cod' &&
      String(payment.delivery_status || '').toLowerCase() !== 'delivered'
    ) {
      return res.status(409).json({ message: 'Cash on delivery can only be marked as paid after the laundry is delivered.' });
    }
    if (
      nextStatus === 'paid' &&
      ['online', 'gcash'].includes(String(payment.payment_method || '').toLowerCase())
    ) {
      return res.status(409).json({ message: 'Online payments must be confirmed by PayMongo.' });
    }
    const sql = "UPDATE payment SET status = ? WHERE payment_id = ?";
    const [result] = await db.query(sql, [nextStatus, id]);

    if (result.affectedRows === 0) {
      const [existingPayment] = await db.query(
        'SELECT payment_id FROM payment WHERE payment_id = ? LIMIT 1',
        [id]
      );
      if (!existingPayment.length) return res.status(404).json({ message: "Payment not found" });
    }

    let paymentRow = null;

    // Read the payment row once so we can emit the latest booking/payment state
    const [rows] = await db.query(
      "SELECT amount, transaction_id, booking_id, customer_id, payment_method FROM payment WHERE payment_id = ?",
      [id]
    );
    paymentRow = rows && rows[0] ? rows[0] : null;

    if (nextStatus === 'paid' && String(paymentRow?.payment_method || '').toLowerCase() === 'gcash' && paymentRow?.booking_id) {
      await activatePaidGcashBooking(paymentRow.booking_id, req.app.get('io'));
    }

    // If marking as paid and not yet linked to a transaction, create one and link it
    if (nextStatus === 'paid') {
      if (paymentRow) {
        let ensuredAmount = paymentRow.amount != null ? Number(paymentRow.amount) : null;

        // 2) If amount is missing/null, pull from booking.total_amount and update payment.amount
        if (ensuredAmount == null || isNaN(ensuredAmount) || ensuredAmount <= 0) {
          try {
            if (paymentRow.booking_id) {
              const [bRows] = await db.query(
                "SELECT total_amount FROM booking WHERE booking_id = ? LIMIT 1",
                [paymentRow.booking_id]
              );
              if (bRows && bRows[0] && bRows[0].total_amount != null) {
                ensuredAmount = Number(bRows[0].total_amount) || 0;
                // Persist the resolved amount back to payment for accurate sales reporting
                await db.query(
                  "UPDATE payment SET amount = ? WHERE payment_id = ?",
                  [ensuredAmount, id]
                );
              } else {
                ensuredAmount = 0;
              }
            } else {
              ensuredAmount = 0;
            }
          } catch (e) {
            console.warn('Failed to backfill payment.amount from booking:', e?.message || e);
            ensuredAmount = 0;
          }
        }

        // 3) Create and link a transaction if not already linked
        if (paymentRow.transaction_id == null || paymentRow.transaction_id === 0) {
          const [tx] = await db.query(
            "INSERT INTO transaction (date, total_payment) VALUES (NOW(), ?)",
            [ensuredAmount || 0]
          );
          const newTxId = tx && tx.insertId ? tx.insertId : null;
          if (newTxId != null) {
            await db.query("UPDATE payment SET transaction_id = ? WHERE payment_id = ?", [newTxId, id]);
          }
        }
      }
    }

    const io = req.app.get('io');
    const bookingId = paymentRow?.booking_id;
    const paymentCustomerId = paymentRow?.customer_id;
    const paymentMethod = paymentRow?.payment_method;
    let customerId = paymentCustomerId;

    if (!customerId && bookingId) {
      try {
        const [bookingRows] = await db.query('SELECT customer_id FROM booking WHERE booking_id = ? LIMIT 1', [bookingId]);
        customerId = bookingRows && bookingRows[0] ? bookingRows[0].customer_id : null;
      } catch (e) {
        console.warn('⚠️ Failed to resolve booking customer_id for payment update:', e?.message || e);
      }
    }

    if (io && io.to && bookingId) {
      const payload = {
        bookingId: Number(bookingId),
        payment_status: nextStatus,
        payment_method: paymentMethod || undefined,
        at: new Date().toISOString(),
      };

      try {
        io.to('role_superadmin').emit('bookingUpdated', payload);
        io.to('role_customer').emit('bookingUpdated', payload);
      } catch (e) {
        console.warn('⚠️ Failed to emit payment status update to role rooms:', e?.message || e);
      }

      if (customerId) {
        try {
          io.to(`user_customer_${customerId}`).emit('bookingUpdated', payload);
          io.to(`user_customer_${customerId}`).emit('newNotification', {
            booking_id: bookingId,
            bookingId: Number(bookingId),
            type: 'payment_status_updated',
            message: 'Payment status updated',
            created_at: new Date().toISOString(),
          });
        } catch (e) {
          console.warn('⚠️ Failed to emit payment status update to customer room:', e?.message || e);
        }
      }
    }

    res.json({ message: "Payment status updated successfully", status: nextStatus });
  } catch (err) {
    console.error("DB Error (updatePaymentStatus):", err);
    res.status(500).json({ message: "Database error", error: err.message });
  }
};

// Get all-time paid sales and monthly breakdown.
exports.getShopSales = async (req, res) => {
  const { shopId } = req.params;
  if (!shopId) return res.status(400).json({ success: false, message: 'shopId required' });
  try {
    const eligiblePaymentFilter = `
      p.shop_id = ?
      AND LOWER(p.status) IN ('paid', 'success', 'succeeded', 'completed')
      AND LOWER(COALESCE(b.status, '')) NOT IN ('cancelled', 'canceled', 'declined', 'rejected')
    `;
    const [rows] = await db.query(
      `SELECT COALESCE(SUM(p.amount), 0) AS total
       FROM payment p
       INNER JOIN booking b ON b.booking_id = p.booking_id
       WHERE ${eligiblePaymentFilter}`,
      [shopId]
    );
    const [breakdown] = await db.query(
      `SELECT YEAR(p.date) AS year, MONTH(p.date) AS month, COALESCE(SUM(p.amount), 0) AS total
       FROM payment p
       INNER JOIN booking b ON b.booking_id = p.booking_id
       WHERE ${eligiblePaymentFilter}
       GROUP BY YEAR(p.date), MONTH(p.date)
       ORDER BY YEAR(p.date) DESC, MONTH(p.date) DESC`,
      [shopId]
    );
    const total = rows && rows[0] ? Number(rows[0].total || 0) : 0;
    return res.json({ success: true, total, breakdown });
  } catch (e) {
    console.error('getShopSales error:', e);
    return res.status(500).json({ success: false, message: e.message || 'Server error' });
  }
};

// Update transaction_id for a payment (new column support)
exports.updatePaymentTransaction = async (req, res) => {
  const { id } = req.params;
  const { transaction_id } = req.body;

  if (transaction_id == null) {
    return res.status(400).json({ message: "transaction_id is required" });
  }

  try {
    const sql = "UPDATE payment SET transaction_id = ? WHERE payment_id = ?";
    const [result] = await db.query(sql, [transaction_id, id]);

    if (result.affectedRows === 0) return res.status(404).json({ message: "Payment not found" });
    res.json({ message: "Payment transaction_id updated successfully" });
  } catch (err) {
    console.error("DB Error (updatePaymentTransaction):", err);
    res.status(500).json({ message: "Database error", error: err.message });
  }
};

// GCash Payment (Hybrid: real or mock)
const paymongoService = require('../service/paymongoService');
const {
  activatePaidGcashBooking,
  discardFailedGcashBooking,
  discardUnstartedGcashBooking,
} = require('./bookingController');

exports.createGCashPayment = async (req, res) => {
  const { amount, description, customerInfo, bookingId } = req.body;
  if (!amount || !description || !customerInfo) {
    return res.status(400).json({ success: false, message: 'Amount, description and customerInfo required' });
  }
  try {
    if (bookingId) {
      const [bookings] = await db.query(
        `SELECT booking_id, customer_id, shop_id, service_id, booking_type, total_amount,
                request_idempotency_key, price_confirmation_status
         FROM booking
         WHERE booking_id = ?
         LIMIT 1`,
        [bookingId]
      );
      if (!bookings.length) {
        return res.status(404).json({ success: false, message: 'Booking not found for this payment' });
      }
      if (bookings[0].request_idempotency_key) {
        return res.status(409).json({
          success: false,
          message: 'Laundry request GCash payments must be started through the authenticated payment flow after delivery.',
        });
      }
      if (bookings[0].request_idempotency_key && !isShopConfirmedPrice(bookings[0].price_confirmation_status)) {
        return res.status(409).json({ success: false, message: 'The shop must confirm the total amount before payment.' });
      }
      if (Math.abs(Number(bookings[0].total_amount) - Number(amount)) > 0.01) {
        return res.status(409).json({ success: false, message: 'Payment amount does not match the booking total' });
      }
    }

    const result = await paymongoService.createGCashPayment(amount, description, customerInfo, bookingId);
    if (!result.success) {
      return res.status(400).json({ success: false, message: result.error || 'Payment creation failed' });
    }

    if (bookingId) {
      const booking = (await db.query(
        `SELECT customer_id, shop_id, service_id, total_amount
         FROM booking
         WHERE booking_id = ?
         LIMIT 1`,
        [bookingId]
      ))[0][0];
      const paymentReference = result.data.paymongoPaymentId || result.data.paymentIntentId;
      const [paymentResult] = await db.query(
        `INSERT INTO payment
          (booking_id, customer_id, shop_id, service_id, payment_method, amount, status, date, paymongo_payment_id)
         VALUES (?, ?, ?, ?, 'gcash', ?, 'pending', NOW(), ?)`,
        [
          bookingId,
          booking.customer_id,
          booking.shop_id,
          booking.service_id,
          Number(booking.total_amount),
          paymentReference
        ]
      );
      result.data.paymentRecordId = paymentResult.insertId;
    }

    res.json({ success: true, data: result.data, mode: paymongoService.mode, message: 'GCash payment created' });
  } catch (e) {
    console.error('createGCashPayment error:', e);
    res.status(500).json({ success: false, message: e.message || 'Server error' });
  }
};

async function markLaundryRequestGCashPaymentPaid({ bookingId, customerId, paymongoPaymentId, io }) {
  const connection = await db.getConnection();
  let payment;

  try {
    await connection.beginTransaction();
    const [paymentRows] = await connection.query(
      `SELECT p.payment_id, p.payment_method, p.amount, p.status,
              p.transaction_id, p.paymongo_payment_id,
              b.booking_id, b.shop_id, b.customer_id, b.booking_type,
              b.total_amount, b.price_confirmation_status, b.request_idempotency_key,
              d.status AS delivery_status
       FROM payment p
       INNER JOIN booking b ON b.booking_id = p.booking_id
       LEFT JOIN delivery d ON d.booking_id = b.booking_id
       WHERE b.booking_id = ?
         AND b.customer_id = ?
         AND p.payment_id = (
           SELECT MAX(latest.payment_id)
           FROM payment latest
           WHERE latest.booking_id = b.booking_id
         )
       LIMIT 1
       FOR UPDATE`,
      [bookingId, customerId],
    );
    if (!paymentRows.length) {
      const error = new Error('Laundry request payment not found');
      error.statusCode = 404;
      throw error;
    }

    payment = paymentRows[0];
    if (
      !['walk in', 'pick up', 'pickup'].includes(String(payment.booking_type || '').trim().toLowerCase()) ||
      !payment.request_idempotency_key ||
      String(payment.payment_method || '').toLowerCase() !== 'gcash'
    ) {
      const error = new Error('This is not a GCash payment for a laundry request');
      error.statusCode = 409;
      throw error;
    }
    if (
      ['pick up', 'pickup'].includes(String(payment.booking_type || '').trim().toLowerCase()) &&
      String(payment.delivery_status || '').toLowerCase() !== 'delivered'
    ) {
      const error = new Error('Pickup payment can only be completed after the laundry is delivered');
      error.statusCode = 409;
      throw error;
    }
    if (
      !isShopConfirmedPrice(payment.price_confirmation_status) ||
      !Number.isFinite(Number(payment.total_amount)) ||
      Number(payment.total_amount) <= 0 ||
      Math.abs(Number(payment.amount) - Number(payment.total_amount)) > 0.01
    ) {
      const error = new Error('The confirmed total amount does not match this payment');
      error.statusCode = 409;
      throw error;
    }

    let transactionId = payment.transaction_id;
    if (!transactionId) {
      const [transactionResult] = await connection.query(
        'INSERT INTO transaction (date, total_payment) VALUES (NOW(), ?)',
        [Number(payment.total_amount)],
      );
      transactionId = transactionResult.insertId;
    }
    await connection.query(
      `UPDATE payment
       SET status = 'paid', paymongo_payment_id = ?, transaction_id = ?
       WHERE payment_id = ?`,
      [paymongoPaymentId || payment.paymongo_payment_id, transactionId, payment.payment_id],
    );
    await connection.commit();
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      console.error('Failed to roll back verified Walk-in GCash payment:', rollbackError);
    }
    throw error;
  } finally {
    connection.release();
  }

  if (io?.to) {
    const updatePayload = {
      bookingId,
      payment_method: 'gcash',
      payment_status: 'paid',
    };
    try {
      io.to(`user_customer_${customerId}`).emit('bookingUpdated', updatePayload);
      io.to('role_customer').emit('bookingUpdated', updatePayload);
      io.to('role_superadmin').emit('bookingUpdated', updatePayload);
      const [shopRows] = await db.query(
        'SELECT admin_id FROM shop WHERE shop_id = ? LIMIT 1',
        [payment.shop_id],
      );
      if (shopRows[0]?.admin_id) {
        io.to(`user_admin_${shopRows[0].admin_id}`).emit('bookingUpdated', updatePayload);
      }
    } catch (notificationError) {
      console.error('Laundry-request GCash payment was confirmed, but update delivery failed:', notificationError);
    }
  }
  return payment;
}

exports.createLaundryRequestGCashPayment = async (req, res) => {
  const bookingId = Number(req.params.bookingId);
  const customerId = req.authenticatedCustomerId;
  const amount = Number(req.body?.amount);
  const description = String(req.body?.description || '').trim();

  if (!Number.isSafeInteger(bookingId) || bookingId <= 0) {
    return res.status(400).json({ success: false, message: 'A valid booking ID is required' });
  }
  if (!Number.isSafeInteger(customerId) || customerId <= 0) {
    return res.status(401).json({ success: false, message: 'A valid customer login is required.' });
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ success: false, message: 'A valid payment amount is required' });
  }
  try {
    const [bookingRows] = await db.query(
      `SELECT b.booking_id, b.customer_id, b.shop_id, b.service_id,
              b.booking_type, b.status AS booking_status, b.total_amount,
              b.price_confirmation_status, b.request_idempotency_key,
              d.status AS delivery_status,
              p.payment_id, p.payment_method, p.amount AS payment_amount,
              p.status AS payment_status, p.paymongo_payment_id
       FROM booking b
       LEFT JOIN delivery d ON d.booking_id = b.booking_id
       LEFT JOIN payment p ON p.payment_id = (
         SELECT MAX(latest.payment_id)
         FROM payment latest
         WHERE latest.booking_id = b.booking_id
       )
       WHERE b.booking_id = ? AND b.customer_id = ?
       LIMIT 1`,
      [bookingId, customerId],
    );
    if (!bookingRows.length) {
      return res.status(404).json({ success: false, message: 'Laundry request not found' });
    }

    const booking = bookingRows[0];
    if (
      !['walk in', 'pick up', 'pickup'].includes(String(booking.booking_type || '').trim().toLowerCase()) ||
      !booking.request_idempotency_key
    ) {
      return res.status(409).json({ success: false, message: 'GCash checkout is only available for laundry requests' });
    }
    const isPickupBooking = ['pick up', 'pickup'].includes(String(booking.booking_type || '').trim().toLowerCase());
    if (
      !(isPickupBooking
        ? ['confirmed', 'processing', 'completed'].includes(String(booking.booking_status || '').toLowerCase())
        : ['processing', 'completed'].includes(String(booking.booking_status || '').toLowerCase())) ||
      !isShopConfirmedPrice(booking.price_confirmation_status) ||
      !Number.isFinite(Number(booking.total_amount)) ||
      Number(booking.total_amount) <= 0 ||
      Math.abs(Number(booking.total_amount) - amount) > 0.01
    ) {
      return res.status(409).json({ success: false, message: 'The shop must confirm the total amount before GCash payment.' });
    }
    if (
      isPickupBooking &&
      String(booking.delivery_status || '').toLowerCase() !== 'delivered'
    ) {
      return res.status(409).json({ success: false, message: 'Pickup online payment is available only after the laundry is delivered.' });
    }
    if (isPickupBooking && !['online', 'gcash'].includes(String(booking.payment_method || '').toLowerCase())) {
      return res.status(409).json({ success: false, message: 'Select Online Payment to pay this pickup request with GCash.' });
    }
    if (
      !booking.payment_id ||
      !['online', 'gcash'].includes(String(booking.payment_method || '').toLowerCase())
    ) {
      return res.status(409).json({ success: false, message: 'Select Online Payment before starting GCash checkout.' });
    }
    if (['paid', 'success', 'succeeded', 'completed'].includes(String(booking.payment_status || '').toLowerCase())) {
      return res.status(409).json({ success: false, message: 'This laundry request has already been paid.' });
    }

    const [customerRows] = await db.query(
      'SELECT first_name, last_name, phone_number FROM customer WHERE customer_id = ? LIMIT 1',
      [customerId],
    );
    if (!customerRows.length) {
      return res.status(404).json({ success: false, message: 'Customer profile not found' });
    }
    const customer = customerRows[0];
    const customerInfo = {
      name: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
      phone: customer.phone_number,
    };

    if (
      String(booking.payment_method || '').toLowerCase() === 'gcash' &&
      String(booking.payment_status || '').toLowerCase() === 'pending' &&
      booking.paymongo_payment_id
    ) {
      const existingStatus = await paymongoService.checkPaymentStatus(booking.paymongo_payment_id);
      if (!existingStatus.success) {
        return res.status(502).json({ success: false, message: existingStatus.error || 'Unable to verify the existing GCash checkout' });
      }
      if (existingStatus.status === 'succeeded') {
        await markLaundryRequestGCashPaymentPaid({
          bookingId,
          customerId,
          paymongoPaymentId: existingStatus.paymongoPaymentId || booking.paymongo_payment_id,
          io: req.app.get('io'),
        });
        return res.json({
          success: true,
          status: 'paid',
          data: { paymentIntentId: booking.paymongo_payment_id, status: 'paid', paymentRecordId: booking.payment_id },
        });
      }
      if (!['canceled', 'failed', 'requires_payment_method', 'awaiting_payment_method'].includes(existingStatus.status)) {
        const existingCheckout = await paymongoService.getGCashCheckout(booking.paymongo_payment_id);
        if (existingCheckout?.redirectUrl) {
          return res.json({
            success: true,
            status: 'processing',
            data: {
              ...existingCheckout,
              paymentRecordId: booking.payment_id,
              status: 'processing',
            },
          });
        }
        return res.status(409).json({ success: false, message: 'A GCash checkout is already processing. Please wait for its result.' });
      }
      await db.query(
        `UPDATE payment SET status = 'failed'
         WHERE payment_id = ?
           AND LOWER(COALESCE(status, '')) NOT IN ('paid', 'success', 'succeeded', 'completed')`,
        [booking.payment_id],
      );
    }

    const result = await paymongoService.createGCashPayment(
      amount,
      description ||       `eLaba ${isPickupBooking ? 'Pickup & Delivery' : 'Walk-in'} Laundry #${bookingId}`,
      customerInfo,
      bookingId,
    );
    if (!result.success) {
      return res.status(400).json({ success: false, message: result.error || 'GCash payment creation failed' });
    }

    const paymentReference = result.data.paymongoPaymentId || result.data.paymentIntentId;
    if (!paymentReference) {
      return res.status(502).json({ success: false, message: 'PayMongo did not return a payment reference' });
    }
    const [updateResult] = await db.query(
      `UPDATE payment
       SET payment_method = 'gcash', amount = ?, status = 'pending', paymongo_payment_id = ?
       WHERE payment_id = ? AND booking_id = ? AND customer_id = ?
         AND LOWER(COALESCE(status, '')) NOT IN ('paid', 'success', 'succeeded', 'completed')`,
      [Number(booking.total_amount), paymentReference, booking.payment_id, bookingId, customerId],
    );
    if (!updateResult.affectedRows) {
      return res.status(409).json({ success: false, message: 'Payment changed while GCash checkout was starting. Refresh and try again.' });
    }

    return res.json({
      success: true,
      status: 'processing',
      data: { ...result.data, paymongoPaymentId: paymentReference, paymentRecordId: booking.payment_id },
      mode: paymongoService.mode,
      message: 'GCash payment created',
    });
  } catch (error) {
    console.error('createLaundryRequestGCashPayment error:', error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode ? error.message : 'Unable to start GCash checkout',
    });
  }
};

exports.verifyLaundryRequestGCashPayment = async (req, res) => {
  const bookingId = Number(req.params.bookingId);
  const customerId = req.authenticatedCustomerId;
  if (!Number.isSafeInteger(bookingId) || bookingId <= 0) {
    return res.status(400).json({ success: false, message: 'A valid booking ID is required' });
  }
  if (!Number.isSafeInteger(customerId) || customerId <= 0) {
    return res.status(401).json({ success: false, message: 'A valid customer login is required.' });
  }

  try {
    const [rows] = await db.query(
      `SELECT b.booking_id, b.customer_id, b.booking_type, b.total_amount,
              b.price_confirmation_status, b.request_idempotency_key,
              p.payment_id, p.payment_method, p.amount AS payment_amount,
              p.status AS payment_status, p.paymongo_payment_id
       FROM booking b
       LEFT JOIN payment p ON p.payment_id = (
         SELECT MAX(latest.payment_id)
         FROM payment latest
         WHERE latest.booking_id = b.booking_id
       )
       WHERE b.booking_id = ? AND b.customer_id = ?
       LIMIT 1`,
      [bookingId, customerId],
    );
    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Walk-in laundry request not found' });
    }

    const payment = rows[0];
    if (
      !['walk in', 'pick up', 'pickup'].includes(String(payment.booking_type || '').trim().toLowerCase()) ||
      !payment.request_idempotency_key ||
      String(payment.payment_method || '').toLowerCase() !== 'gcash'
    ) {
      return res.status(409).json({ success: false, message: 'This is not a GCash payment for a laundry request' });
    }
    if (
      !isShopConfirmedPrice(payment.price_confirmation_status) ||
      !Number.isFinite(Number(payment.total_amount)) ||
      Number(payment.total_amount) <= 0 ||
      Math.abs(Number(payment.payment_amount) - Number(payment.total_amount)) > 0.01
    ) {
      return res.status(409).json({ success: false, message: 'The confirmed total amount does not match this payment' });
    }

    const currentStatus = String(payment.payment_status || '').toLowerCase();
    if (['paid', 'success', 'succeeded', 'completed'].includes(currentStatus)) {
      await markLaundryRequestGCashPaymentPaid({
        bookingId,
        customerId,
        paymongoPaymentId: payment.paymongo_payment_id,
        io: req.app.get('io'),
      });
      return res.json({ success: true, status: 'paid', payment_method: 'gcash', payment_status: 'paid' });
    }
    if (!payment.paymongo_payment_id) {
      return res.status(409).json({ success: false, message: 'No active PayMongo checkout was found for this request' });
    }

    const providerResult = await paymongoService.checkPaymentStatus(payment.paymongo_payment_id);
    if (!providerResult.success) {
      return res.status(502).json({ success: false, message: providerResult.error || 'Unable to verify GCash payment' });
    }
    if (providerResult.status === 'succeeded') {
      await markLaundryRequestGCashPaymentPaid({
        bookingId,
        customerId,
        paymongoPaymentId: providerResult.paymongoPaymentId || payment.paymongo_payment_id,
        io: req.app.get('io'),
      });
      return res.json({ success: true, status: 'paid', payment_method: 'gcash', payment_status: 'paid' });
    }

    if (['canceled', 'failed', 'requires_payment_method', 'awaiting_payment_method'].includes(providerResult.status)) {
      await db.query(
        `UPDATE payment SET status = 'failed'
         WHERE payment_id = ?
           AND LOWER(COALESCE(status, '')) NOT IN ('paid', 'success', 'succeeded', 'completed')`,
        [payment.payment_id],
      );
      return res.json({ success: true, status: 'failed', payment_method: 'gcash', payment_status: 'failed' });
    }
    return res.json({ success: true, status: 'processing', payment_method: 'gcash', payment_status: 'pending' });
  } catch (error) {
    console.error('verifyLaundryRequestGCashPayment error:', error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.statusCode ? error.message : 'Unable to verify GCash payment',
    });
  }
};

exports.createWalkInGCashPayment = exports.createLaundryRequestGCashPayment;
exports.verifyWalkInGCashPayment = exports.verifyLaundryRequestGCashPayment;

async function getDeliveryQrPhContext(connection, bookingId, lockForUpdate = false) {
  const lockClause = lockForUpdate ? ' FOR UPDATE' : '';
  const [bookingRows] = await connection.query(
    `SELECT b.booking_id, b.booking_type, b.customer_id, b.shop_id, b.service_id,
            b.total_amount, b.price_confirmation_status,
            d.delivery_id, d.status AS delivery_status,
            s.admin_id
     FROM booking b
     INNER JOIN delivery d ON d.booking_id = b.booking_id
     INNER JOIN shop s ON s.shop_id = b.shop_id
     WHERE b.booking_id = ?
     LIMIT 1${lockClause}`,
    [bookingId],
  );
  if (!bookingRows.length) return null;

  const [paymentRows] = await connection.query(
    `SELECT payment_id, payment_method, amount, status, paymongo_payment_id
     FROM payment
     WHERE booking_id = ?
     ORDER BY payment_id DESC
     LIMIT 1${lockClause}`,
    [bookingId],
  );

  return { booking: bookingRows[0], payment: paymentRows[0] || null };
}

function assertDeliveryQrPhContext(
  context,
  adminId,
  { allowDelivered = false, allowPaid = false } = {},
) {
  if (!context) {
    const error = new Error('Pickup or delivery booking was not found');
    error.statusCode = 404;
    throw error;
  }

  const { booking, payment } = context;
  if (Number(booking.admin_id) !== adminId) {
    const error = new Error('You are not authorized to collect payment for this shop');
    error.statusCode = 403;
    throw error;
  }

  const bookingType = String(booking.booking_type || '').toLowerCase();
  if (!bookingType.includes('pick') && !bookingType.includes('deliver')) {
    const error = new Error('QR Ph collection is only available for pickup and delivery bookings');
    error.statusCode = 409;
    throw error;
  }

  const deliveryStatus = String(booking.delivery_status || '').toLowerCase();
  if (
    deliveryStatus !== 'out_for_delivery' &&
    !(allowDelivered && deliveryStatus === 'delivered')
  ) {
    const error = new Error(
      allowDelivered
        ? 'QR Ph can only be verified while the delivery is out for delivery or delivered'
        : 'QR Ph can only be generated while the delivery is out for delivery',
    );
    error.statusCode = 409;
    throw error;
  }

  if (!isShopConfirmedPrice(booking.price_confirmation_status)) {
    const error = new Error('The shop must confirm the total amount before QR Ph payment');
    error.statusCode = 409;
    throw error;
  }

  const totalAmount = Number(booking.total_amount);
  if (!Number.isFinite(totalAmount) || totalAmount < 1) {
    const error = new Error('A confirmed payment amount of at least PHP 1.00 is required');
    error.statusCode = 409;
    throw error;
  }
  if (!payment) {
    const error = new Error('No payment record exists for this booking');
    error.statusCode = 409;
    throw error;
  }
  if (
    payment &&
    !allowPaid &&
    ['paid', 'success', 'succeeded', 'completed'].includes(String(payment.status || '').toLowerCase())
  ) {
    const error = new Error('This booking has already been paid');
    error.statusCode = 409;
    throw error;
  }

  return totalAmount;
}

function getDeliveryQrPhResponse(bookingId, payment, qrPhPayment, reused) {
  return {
    bookingId,
    paymentRecordId: payment.payment_id,
    paymentIntentId: qrPhPayment.paymentIntentId,
    paymentReference: qrPhPayment.paymentIntentId || payment.paymongo_payment_id,
    paymentMethod: 'qrph',
    amount: qrPhPayment.amount ?? Number(payment.amount),
    currency: qrPhPayment.currency || 'PHP',
    status: qrPhPayment.status,
    qrImage: qrPhPayment.qrImage,
    expirySeconds: qrPhPayment.expirySeconds,
    expiresAt: qrPhPayment.expiresAt,
    reused,
  };
}

async function getWalkInQrPhContext(connection, bookingId, customerId, lockForUpdate = false) {
  const lockClause = lockForUpdate ? ' FOR UPDATE' : '';
  const [bookingRows] = await connection.query(
    `SELECT b.booking_id, b.booking_type, b.customer_id, b.shop_id, b.service_id,
            b.total_amount, b.price_confirmation_status, b.status,
            s.admin_id
     FROM booking b
     LEFT JOIN shop s ON s.shop_id = b.shop_id
     WHERE b.booking_id = ?
       AND (? IS NULL OR b.customer_id = ?)
     LIMIT 1${lockClause}`,
    [bookingId, customerId ?? null, customerId ?? null],
  );
  if (!bookingRows.length) return null;
  const [paymentRows] = await connection.query(
    `SELECT payment_id, payment_method, amount, status, paymongo_payment_id
     FROM payment WHERE booking_id = ? ORDER BY payment_id DESC LIMIT 1${lockClause}`,
    [bookingId],
  );
  return { booking: bookingRows[0], payment: paymentRows[0] || null };
}

function assertWalkInQrPhContext(context, adminId = null) {
  if (!context) {
    const error = new Error('Walk-in laundry request was not found');
    error.statusCode = 404;
    throw error;
  }
  const { booking, payment } = context;
  if (adminId != null && Number(booking.admin_id) !== Number(adminId)) {
    const error = new Error('You are not authorized to collect payment for this shop');
    error.statusCode = 403;
    throw error;
  }
  if (String(booking.booking_type || '').trim().toLowerCase() !== 'walk in') {
    const error = new Error('QR Ph walk-in payment is only available for walk-in laundry');
    error.statusCode = 409;
    throw error;
  }
  if (!['processing', 'completed'].includes(String(booking.status || '').toLowerCase())) {
    const error = new Error('QR Ph payment is available after laundry processing starts');
    error.statusCode = 409;
    throw error;
  }
  if (!isShopConfirmedPrice(booking.price_confirmation_status)) {
    const error = new Error('The shop must confirm the total amount before QR Ph payment');
    error.statusCode = 409;
    throw error;
  }
  const totalAmount = Number(booking.total_amount);
  if (!Number.isFinite(totalAmount) || totalAmount < 1 || !payment) {
    const error = new Error('A confirmed payment amount and payment record are required');
    error.statusCode = 409;
    throw error;
  }
  return totalAmount;
}

exports.createWalkInQrPhPayment = async (req, res) => {
  const bookingId = Number(req.params.bookingId);
  const customerId = req.authenticatedCustomerId ?? null;
  const adminId = req.authenticatedAdminId ?? null;
  if (!Number.isSafeInteger(bookingId) || bookingId <= 0) {
    return res.status(400).json({ success: false, message: 'A valid booking ID is required' });
  }
  if (customerId == null && adminId == null) {
    return res.status(401).json({ success: false, message: 'A valid customer login is required.' });
  }
  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();
    const context = await getWalkInQrPhContext(connection, bookingId, customerId, true);
    const totalAmount = assertWalkInQrPhContext(context, adminId);
    const { booking, payment } = context;
    if (adminId == null && String(payment.payment_method || '').toLowerCase() !== 'qrph') {
      const error = new Error('Select QR Ph as the online payment provider first');
      error.statusCode = 409;
      throw error;
    }
    if (!['pending', 'failed', 'cancelled'].includes(String(payment.status || '').toLowerCase())) {
      const error = new Error('This payment is not eligible for QR Ph collection');
      error.statusCode = 409;
      throw error;
    }
    let replaceReference = false;
    if (payment.paymongo_payment_id) {
      const existing = await paymongoService.getQrPhPayment(payment.paymongo_payment_id);
      if (!existing.success) {
        const error = new Error(existing.error || 'Unable to retrieve the existing QR Ph payment');
        error.statusCode = 502;
        throw error;
      }
      if (['pending', 'paid'].includes(existing.data.status)) {
        await connection.commit();
        if (existing.data.status === 'paid') {
          await finalizeVerifiedQrPhPayment({
            paymentId: payment.payment_id,
            references: [
              payment.paymongo_payment_id,
              existing.data.paymentIntentId,
              existing.data.paymongoPaymentId,
            ],
            providerData: existing.data,
            io: req.app.get('io'),
          });
          payment.status = 'paid';
        }
        return res.json({ success: true, data: getDeliveryQrPhResponse(bookingId, payment, existing.data, true) });
      }
      if (['failed', 'expired'].includes(existing.data.status)) replaceReference = true;
    }
    const qrPhResult = await paymongoService.createQrPhPayment(
      totalAmount,
      `eLaba Walk-in Booking #${booking.booking_id}`,
      { booking_id: String(booking.booking_id), payment_id: String(payment.payment_id), booking_type: 'walk_in' },
    );
    if (!qrPhResult.success) {
      const error = new Error(qrPhResult.error || 'Unable to create QR Ph payment');
      error.statusCode = 502;
      throw error;
    }
    const qrPhPayment = qrPhResult.data;
    const [updateResult] = await connection.query(
      `UPDATE payment SET payment_method = 'qrph', amount = ?, status = 'pending', paymongo_payment_id = ?
       WHERE payment_id = ? AND booking_id = ? AND LOWER(COALESCE(status, '')) IN ('pending', 'failed', 'cancelled')
       AND (paymongo_payment_id IS NULL OR paymongo_payment_id = ?)`,
      [totalAmount, qrPhPayment.paymentIntentId, payment.payment_id, bookingId, replaceReference ? payment.paymongo_payment_id : null],
    );
    if (!updateResult.affectedRows) {
      const error = new Error('Payment changed while QR Ph was starting. Refresh and try again.');
      error.statusCode = 409;
      throw error;
    }
    payment.payment_method = 'qrph';
    payment.amount = totalAmount;
    payment.status = 'pending';
    payment.paymongo_payment_id = qrPhPayment.paymentIntentId;
    await connection.commit();
    emitQrPhPaymentStatus(req.app.get('io'), bookingId, booking.customer_id, 'pending');
    return res.status(201).json({ success: true, data: getDeliveryQrPhResponse(bookingId, payment, qrPhPayment, false) });
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); } catch (rollbackError) {
        console.error('Failed to roll back walk-in QR Ph creation:', rollbackError);
      }
    }
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
    console.error('createWalkInQrPhPayment error:', error);
    return res.status(500).json({ success: false, message: 'Unable to create QR Ph payment' });
  } finally {
    if (connection) connection.release();
  }
};

exports.verifyWalkInQrPhPayment = async (req, res) => {
  const bookingId = Number(req.params.bookingId);
  const customerId = req.authenticatedCustomerId ?? null;
  const adminId = req.authenticatedAdminId ?? null;
  let connection;
  try {
    if (!Number.isSafeInteger(bookingId) || bookingId <= 0) {
      return res.status(400).json({ success: false, message: 'A valid booking ID is required' });
    }
    if (customerId == null && adminId == null) {
      return res.status(401).json({ success: false, message: 'A valid customer login is required.' });
    }
    connection = await db.getConnection();
    const context = await getWalkInQrPhContext(connection, bookingId, customerId);
    assertWalkInQrPhContext(context, adminId);
    const { payment } = context;
    if (String(payment.payment_method || '').toLowerCase() !== 'qrph' || !payment.paymongo_payment_id) {
      return res.status(409).json({ success: false, message: 'No QR Ph payment is active for this booking' });
    }
    const result = await paymongoService.getQrPhPayment(payment.paymongo_payment_id);
    if (!result.success) return res.status(502).json({ success: false, message: result.error || 'Unable to verify QR Ph payment' });
    if (result.data.status === 'paid') {
      await finalizeVerifiedQrPhPayment({
        paymentId: payment.payment_id,
        references: [payment.paymongo_payment_id, result.data.paymentIntentId, result.data.paymongoPaymentId],
        providerData: result.data,
        io: req.app.get('io'),
      });
      payment.status = 'paid';
    } else if (['failed', 'expired'].includes(result.data.status)) {
      const currentStatus = await markQrPhPaymentFailed({
        paymentId: payment.payment_id,
        references: [payment.paymongo_payment_id, result.data.paymentIntentId, result.data.paymongoPaymentId],
        io: req.app.get('io'),
      });
      if (currentStatus === 'paid') result.data.status = 'paid';
    }
    return res.json({ success: true, data: { ...getDeliveryQrPhResponse(bookingId, payment, result.data, true), status: result.data.status } });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ success: false, message: error.message });
    console.error('verifyWalkInQrPhPayment error:', error);
    return res.status(500).json({ success: false, message: 'Unable to verify QR Ph payment' });
  } finally {
    if (connection) connection.release();
  }
};

exports.createDeliveryQrPhPayment = async (req, res) => {
  const bookingId = Number(req.params.bookingId);
  const adminId = req.authenticatedAdminId;
  if (!Number.isSafeInteger(bookingId) || bookingId <= 0) {
    return res.status(400).json({ success: false, message: 'A valid booking ID is required' });
  }
  if (!Number.isSafeInteger(adminId) || adminId <= 0) {
    return res.status(401).json({ success: false, message: 'A valid staff login is required.' });
  }

  try {
    const [bookingRows] = await db.query(
      'SELECT booking_type FROM booking WHERE booking_id = ? LIMIT 1',
      [bookingId],
    );
    if (
      bookingRows[0] &&
      String(bookingRows[0].booking_type || '').trim().toLowerCase().replace(/[\s_-]/g, '') === 'walkin'
    ) {
      return exports.createWalkInQrPhPayment(req, res);
    }
  } catch (error) {
    console.error('Unable to detect walk-in QR Ph booking:', error);
  }

  let connection;
  try {
    connection = await db.getConnection();
    await connection.beginTransaction();
    const context = await getDeliveryQrPhContext(connection, bookingId, true);
    const totalAmount = assertDeliveryQrPhContext(context, adminId);
    const { booking, payment } = context;
    const paymentStatus = String(payment.status || '').toLowerCase();
    if (!['pending', 'failed', 'cancelled'].includes(paymentStatus)) {
      const error = new Error('This payment is not eligible for QR Ph collection');
      error.statusCode = 409;
      throw error;
    }

    const paymentMethod = String(payment.payment_method || '').toLowerCase();
    if (paymentMethod !== 'qrph') {
      const error = new Error('The customer must select QR Ph before the shop can generate a payment code');
      error.statusCode = 409;
      throw error;
    }

    let replaceQrPhReference = false;
    if (paymentMethod === 'qrph' && payment.paymongo_payment_id) {
      const existingQrPhPayment = await paymongoService.getQrPhPayment(payment.paymongo_payment_id);
      if (!existingQrPhPayment.success) {
        const error = new Error(existingQrPhPayment.error || 'Unable to retrieve the existing QR Ph payment');
        error.statusCode = 502;
        throw error;
      }
      if (['pending', 'paid'].includes(existingQrPhPayment.data.status)) {
        await connection.commit();
        if (existingQrPhPayment.data.status === 'paid') {
          await finalizeVerifiedQrPhPayment({
            paymentId: payment.payment_id,
            references: [
              payment.paymongo_payment_id,
              existingQrPhPayment.data.paymentIntentId,
              existingQrPhPayment.data.paymongoPaymentId,
            ],
            providerData: existingQrPhPayment.data,
            io: req.app.get('io'),
          });
        }
        return res.json({
          success: true,
          data: getDeliveryQrPhResponse(
            bookingId,
            payment,
            existingQrPhPayment.data,
            true,
          ),
        });
      }
      if (['failed', 'expired'].includes(existingQrPhPayment.data.status)) {
        replaceQrPhReference = true;
      } else {
        const error = new Error('The existing QR Ph payment is not in a retryable state');
        error.statusCode = 409;
        throw error;
      }
    }

    if (payment.paymongo_payment_id && !replaceQrPhReference) {
      const error = new Error('An existing online payment reference must be resolved before starting QR Ph');
      error.statusCode = 409;
      throw error;
    }

    const qrPhResult = await paymongoService.createQrPhPayment(
      totalAmount,
      `eLaba Pickup and Delivery Booking #${booking.booking_id}`,
      {
        booking_id: String(booking.booking_id),
        payment_id: String(payment.payment_id),
        delivery_id: String(booking.delivery_id),
      },
    );
    if (!qrPhResult.success) {
      const error = new Error(qrPhResult.error || 'Unable to create QR Ph payment');
      error.statusCode = 502;
      throw error;
    }

    const qrPhPayment = qrPhResult.data;
    const [updateResult] = await connection.query(
      `UPDATE payment
       SET payment_method = 'qrph', amount = ?, status = 'pending', paymongo_payment_id = ?
       WHERE payment_id = ? AND booking_id = ?
         AND LOWER(COALESCE(status, '')) IN ('pending', 'failed', 'cancelled')
         AND (paymongo_payment_id IS NULL OR paymongo_payment_id = ?)`,
      [
        totalAmount,
        qrPhPayment.paymentIntentId,
        payment.payment_id,
        bookingId,
        replaceQrPhReference ? payment.paymongo_payment_id : null,
      ],
    );
    if (!updateResult.affectedRows) {
      const error = new Error('Payment changed while QR Ph was starting. Refresh and try again.');
      error.statusCode = 409;
      throw error;
    }
    payment.payment_method = 'qrph';
    payment.amount = totalAmount;
    payment.status = 'pending';
    payment.paymongo_payment_id = qrPhPayment.paymentIntentId;
    await connection.commit();
    emitQrPhPaymentStatus(req.app.get('io'), bookingId, booking.customer_id, 'pending');

    return res.status(201).json({
      success: true,
      data: getDeliveryQrPhResponse(bookingId, payment, qrPhPayment, false),
    });
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error('Failed to roll back QR Ph creation:', rollbackError);
      }
    }
    if (error.statusCode) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    console.error('createDeliveryQrPhPayment error:', error);
    return res.status(500).json({ success: false, message: 'Unable to create QR Ph payment' });
  } finally {
    if (connection) connection.release();
  }
};

exports.verifyDeliveryQrPhPayment = async (req, res) => {
  const bookingId = Number(req.params.bookingId);
  const adminId = req.authenticatedAdminId;
  if (!Number.isSafeInteger(bookingId) || bookingId <= 0) {
    return res.status(400).json({ success: false, message: 'A valid booking ID is required' });
  }
  if (!Number.isSafeInteger(adminId) || adminId <= 0) {
    return res.status(401).json({ success: false, message: 'A valid staff login is required.' });
  }

  try {
    const [bookingRows] = await db.query(
      'SELECT booking_type FROM booking WHERE booking_id = ? LIMIT 1',
      [bookingId],
    );
    if (
      bookingRows[0] &&
      String(bookingRows[0].booking_type || '').trim().toLowerCase().replace(/[\s_-]/g, '') === 'walkin'
    ) {
      return exports.verifyWalkInQrPhPayment(req, res);
    }
  } catch (error) {
    console.error('Unable to detect walk-in QR Ph verification:', error);
  }

  let connection;
  try {
    connection = await db.getConnection();
    const context = await getDeliveryQrPhContext(connection, bookingId);
    assertDeliveryQrPhContext(context, adminId, { allowDelivered: true, allowPaid: true });
    const { payment } = context;
    if (
      String(payment.payment_method || '').toLowerCase() !== 'qrph' ||
      !payment.paymongo_payment_id
    ) {
      return res.status(409).json({ success: false, message: 'No QR Ph payment is active for this booking' });
    }

    const result = await paymongoService.getQrPhPayment(payment.paymongo_payment_id);
    if (!result.success) {
      return res.status(502).json({ success: false, message: result.error || 'Unable to verify QR Ph payment' });
    }
    if (result.data.status === 'paid') {
      await finalizeVerifiedQrPhPayment({
        paymentId: payment.payment_id,
        references: [
          payment.paymongo_payment_id,
          result.data.paymentIntentId,
          result.data.paymongoPaymentId,
        ],
        providerData: result.data,
        io: req.app.get('io'),
      });
      payment.status = 'paid';
    } else if (['failed', 'expired'].includes(result.data.status)) {
      const currentStatus = await markQrPhPaymentFailed({
        paymentId: payment.payment_id,
        references: [payment.paymongo_payment_id, result.data.paymentIntentId, result.data.paymongoPaymentId],
        io: req.app.get('io'),
      });
      if (currentStatus === 'paid') result.data.status = 'paid';
    }
    return res.json({
      success: true,
      data: {
        ...getDeliveryQrPhResponse(bookingId, payment, result.data, true),
        status: result.data.status,
      },
    });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    console.error('verifyDeliveryQrPhPayment error:', error);
    return res.status(500).json({ success: false, message: 'Unable to verify QR Ph payment' });
  } finally {
    if (connection) connection.release();
  }
};

exports.checkPaymentStatus = async (req, res) => {
  const { paymentIntentId } = req.params;
  if (!paymentIntentId) return res.status(400).json({ success: false, message: 'paymentIntentId required' });
  try {
    const result = await paymongoService.checkPaymentStatus(paymentIntentId);
    if (!result.success) return res.status(400).json({ success: false, message: result.error });
    res.json({
      success: true,
      status: result.status,
      paymongoPaymentId: result.paymongoPaymentId || null,
      data: result.data
    });
  } catch (e) {
    console.error('checkPaymentStatus error:', e);
    res.status(500).json({ success: false, message: e.message || 'Server error' });
  }
};

exports.cleanupFailedGCashBooking = async (req, res) => {
  const bookingId = Number(req.params.bookingId);
  const customerId = Number(req.body.customer_id);
  if (!Number.isInteger(bookingId) || bookingId <= 0 || !Number.isInteger(customerId) || customerId <= 0) {
    return res.status(400).json({ success: false, message: 'Valid booking_id and customer_id are required' });
  }

  try {
    const [rows] = await db.query(
      `SELECT p.payment_id, p.status AS payment_status, p.payment_method, p.paymongo_payment_id,
              b.customer_id, b.booking_id, b.request_idempotency_key, b.price_confirmation_status
       FROM booking b
       LEFT JOIN payment p ON p.booking_id = b.booking_id
       WHERE b.booking_id = ?
       ORDER BY CASE
         WHEN LOWER(COALESCE(p.status, '')) = 'paid' THEN 0
         WHEN LOWER(COALESCE(p.status, '')) NOT IN ('failed', 'cancelled') THEN 1
         ELSE 2
       END, p.payment_id DESC
       LIMIT 1`,
      [bookingId]
    );
    if (!rows.length) {
      return res.json({ success: true, status: 'not_found', deleted: false });
    }
    const payment = rows[0];
    if (Number(payment.customer_id) !== customerId) {
      return res.status(403).json({ success: false, message: 'You are not authorized to update this booking' });
    }
    if (payment.request_idempotency_key && !isShopConfirmedPrice(payment.price_confirmation_status)) {
      return res.status(409).json({
        success: false,
        message: 'The shop must confirm the total amount before payment can be completed.',
      });
    }
    if (String(payment.payment_method || '').toLowerCase() !== 'gcash') {
      if (!payment.payment_id) {
        const cleanup = await discardUnstartedGcashBooking(bookingId, customerId);
        return res.json({ success: true, status: cleanup.deleted ? 'failed' : 'not_found', deleted: cleanup.deleted });
      }
      return res.status(409).json({ success: false, message: 'This is not a GCash booking' });
    }
    if (!payment.payment_id) {
      const cleanup = await discardUnstartedGcashBooking(bookingId, customerId);
      return res.json({ success: true, status: cleanup.deleted ? 'failed' : 'not_found', deleted: cleanup.deleted });
    }
    if (['paid', 'success', 'succeeded', 'completed'].includes(String(payment.payment_status || '').toLowerCase())) {
      return res.json({ success: true, status: 'paid', deleted: false });
    }
    if (!payment.paymongo_payment_id) {
      return res.status(409).json({
        success: false,
        message: 'PayMongo has not provided a payment reference yet. The draft booking was kept for safety.'
      });
    }

    const providerResult = await paymongoService.checkPaymentStatus(payment.paymongo_payment_id);
    if (!providerResult.success) {
      return res.status(502).json({
        success: false,
        message: providerResult.error || 'Unable to verify payment status with PayMongo'
      });
    }
    if (providerResult.status === 'succeeded') {
      await db.query(
        'UPDATE payment SET status = ?, paymongo_payment_id = ? WHERE payment_id = ?',
        ['paid', providerResult.paymongoPaymentId || payment.paymongo_payment_id, payment.payment_id]
      );
      await activatePaidGcashBooking(bookingId, req.app.get('io'));
      const [bookingRows] = await db.query(
        `SELECT booking_type FROM booking WHERE booking_id = ? LIMIT 1`,
        [bookingId]
      );
      if (String(bookingRows[0]?.booking_type || '').toLowerCase().includes('pick')) {
        await deliveryController.ensureDeliveryRecord({
          booking_id: bookingId,
          status: 'pending',
          io: req.app.get('io')
        });
      }
      return res.json({ success: true, status: 'paid', deleted: false });
    }
    if (providerResult.status !== 'canceled' && providerResult.status !== 'failed') {
      return res.json({ success: true, status: 'processing', deleted: false });
    }

    await db.query(
      `UPDATE payment SET status = ?
       WHERE payment_id = ?
         AND LOWER(COALESCE(status, '')) NOT IN ('paid', 'success', 'succeeded', 'completed')`,
      ['failed', payment.payment_id]
    );
    const cleanup = await discardFailedGcashBooking(bookingId, customerId);
    if (!cleanup.deleted && cleanup.reason === 'not_found') {
      const [currentPaymentRows] = await db.query(
        'SELECT status FROM payment WHERE payment_id = ? LIMIT 1',
        [payment.payment_id]
      );
      if (String(currentPaymentRows[0]?.status || '').toLowerCase() === 'paid') {
        return res.json({ success: true, status: 'paid', deleted: false });
      }
    }
    return res.json({ success: true, status: 'failed', deleted: cleanup.deleted });
  } catch (error) {
    console.error('cleanupFailedGCashBooking error:', error);
    return res.status(500).json({ success: false, message: 'Unable to verify and clean up failed GCash booking' });
  }
};

function verifyPayMongoSignature(rawBody, signatureHeader, webhookSecret) {
  if (!rawBody || !signatureHeader || !webhookSecret) return false;
  const parts = Object.fromEntries(
    String(signatureHeader).split(',').map((part) => {
      const [key, ...value] = part.split('=');
      return [key, value.join('=')];
    })
  );
  const timestamp = parts.t;
  const mode = String(process.env.PAYMONGO_MODE || '').toLowerCase();
  const expectedSignature = ['test', 'sandbox'].includes(mode) ? parts.te : parts.li;
  if (!timestamp || !expectedSignature) return false;
  const signedPayload = `${timestamp}.${rawBody.toString('utf8')}`;
  const computedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(signedPayload)
    .digest('hex');
  const expected = Buffer.from(expectedSignature, 'utf8');
  const computed = Buffer.from(computedSignature, 'utf8');
  return expected.length === computed.length && crypto.timingSafeEqual(expected, computed);
}

function emitQrPhPaymentStatus(io, bookingId, customerId, status) {
  if (!io || typeof io.to !== 'function' || !bookingId) return;
  const payload = {
    bookingId: Number(bookingId),
    payment_status: status,
    payment_method: 'qrph',
    at: new Date().toISOString(),
  };
  io.to('role_superadmin').emit('bookingUpdated', payload);
  io.to('role_customer').emit('bookingUpdated', payload);
  db.query(
    `SELECT s.admin_id
     FROM booking b
     INNER JOIN shop s ON s.shop_id = b.shop_id
     WHERE b.booking_id = ?
     LIMIT 1`,
    [bookingId],
  ).then(([rows]) => {
    const adminId = rows[0]?.admin_id;
    if (adminId) io.to(`user_admin_${adminId}`).emit('bookingUpdated', payload);
  }).catch(error => {
    console.error('Failed to emit QR Ph payment update to shop staff:', error);
  });
  if (customerId) {
    io.to(`user_customer_${customerId}`).emit('bookingUpdated', payload);
  }
}

async function finalizeVerifiedQrPhPayment({ paymentId, references, providerData, io }) {
  const connection = await db.getConnection();
  let bookingId;
  let customerId;
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT p.payment_id, p.payment_method, p.amount, p.status AS payment_status,
              p.paymongo_payment_id, p.transaction_id,
              b.booking_id, b.total_amount, b.price_confirmation_status, b.customer_id
       FROM payment p
       INNER JOIN booking b ON b.booking_id = p.booking_id
       WHERE p.payment_id = ?
       LIMIT 1
       FOR UPDATE`,
      [paymentId],
    );
    if (!rows.length) {
      const error = new Error('QR Ph payment record was not found');
      error.statusCode = 404;
      throw error;
    }

    const payment = rows[0];
    const acceptedReferences = new Set((references || []).filter(Boolean).map(String));
    if (
      String(payment.payment_method || '').toLowerCase() !== 'qrph' ||
      !payment.paymongo_payment_id ||
      !acceptedReferences.has(String(payment.paymongo_payment_id))
    ) {
      const error = new Error('PayMongo payment reference does not match the QR Ph record');
      error.statusCode = 409;
      throw error;
    }
    if (!isShopConfirmedPrice(payment.price_confirmation_status)) {
      const error = new Error('The booking price is not confirmed');
      error.statusCode = 409;
      throw error;
    }
    if (String(providerData?.status || '').toLowerCase() !== 'paid') {
      const error = new Error('PayMongo has not confirmed this payment as paid');
      error.statusCode = 409;
      throw error;
    }

    const bookingAmountCents = Math.round(Number(payment.total_amount) * 100);
    const recordedAmountCents = Math.round(Number(payment.amount) * 100);
    const providerAmountCents = Math.round(Number(providerData.amount) * 100);
    if (
      !Number.isSafeInteger(bookingAmountCents) ||
      bookingAmountCents < 100 ||
      !Number.isSafeInteger(recordedAmountCents) ||
      recordedAmountCents !== bookingAmountCents ||
      !Number.isSafeInteger(providerAmountCents) ||
      providerAmountCents !== bookingAmountCents ||
      String(providerData.currency || '').toUpperCase() !== 'PHP'
    ) {
      const error = new Error('PayMongo payment amount does not match the confirmed booking amount');
      error.statusCode = 409;
      throw error;
    }

    let transactionId = payment.transaction_id;
    if (transactionId == null || Number(transactionId) === 0) {
      const [transactionResult] = await connection.query(
        'INSERT INTO transaction (date, total_payment) VALUES (NOW(), ?)',
        [bookingAmountCents / 100],
      );
      transactionId = transactionResult.insertId;
    }
    await connection.query(
      `UPDATE payment
       SET status = 'paid', transaction_id = ?
       WHERE payment_id = ? AND LOWER(COALESCE(payment_method, '')) = 'qrph'`,
      [transactionId, payment.payment_id],
    );
    bookingId = payment.booking_id;
    customerId = payment.customer_id;
    await connection.commit();
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      console.error('Failed to roll back QR Ph finalization:', rollbackError);
    }
    throw error;
  } finally {
    connection.release();
  }

  emitQrPhPaymentStatus(io, bookingId, customerId, 'paid');
  return { bookingId, customerId, status: 'paid' };
}

async function markQrPhPaymentFailed({ paymentId, references, io }) {
  const connection = await db.getConnection();
  let bookingId;
  let customerId;
  let resultStatus = 'failed';
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT p.payment_method, p.status AS payment_status, p.paymongo_payment_id,
              b.booking_id, b.customer_id
       FROM payment p
       INNER JOIN booking b ON b.booking_id = p.booking_id
       WHERE p.payment_id = ?
       LIMIT 1
       FOR UPDATE`,
      [paymentId],
    );
    if (!rows.length) {
      await connection.commit();
      return 'not_found';
    }

    const payment = rows[0];
    const acceptedReferences = new Set((references || []).filter(Boolean).map(String));
    if (
      String(payment.payment_method || '').toLowerCase() !== 'qrph' ||
      !payment.paymongo_payment_id ||
      !acceptedReferences.has(String(payment.paymongo_payment_id))
    ) {
      await connection.commit();
      return 'unmatched';
    }

    bookingId = payment.booking_id;
    customerId = payment.customer_id;
    if (['paid', 'success', 'succeeded', 'completed'].includes(String(payment.payment_status || '').toLowerCase())) {
      resultStatus = 'paid';
    } else {
      await connection.query(
        `UPDATE payment SET status = 'failed'
         WHERE payment_id = ?
           AND LOWER(COALESCE(payment_method, '')) = 'qrph'
           AND LOWER(COALESCE(status, '')) NOT IN ('paid', 'success', 'succeeded', 'completed')`,
        [paymentId],
      );
    }
    await connection.commit();
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      console.error('Failed to roll back QR Ph failure update:', rollbackError);
    }
    throw error;
  } finally {
    connection.release();
  }

  emitQrPhPaymentStatus(io, bookingId, customerId, resultStatus);
  return resultStatus;
}

function getQrPhWebhookReferences(resource) {
  const attributes = resource?.attributes || {};
  const payments = attributes.payments;
  const nestedPayment = Array.isArray(payments) ? payments[0] : payments;
  const nestedPaymentAttributes = nestedPayment?.attributes || {};
  const paymentIntent = attributes.payment_intent || nestedPaymentAttributes.payment_intent;
  return [...new Set([
    resource?.id,
    attributes.payment_intent_id,
    typeof paymentIntent === 'string' ? paymentIntent : paymentIntent?.id,
    nestedPaymentAttributes.payment_intent_id,
    nestedPayment?.id,
  ].filter(Boolean).map(String))];
}

async function handleQrPhWebhook(eventType, resource, io) {
  const references = getQrPhWebhookReferences(resource);
  if (!references.length) return false;

  const placeholders = references.map(() => '?').join(', ');
  const [rows] = await db.query(
    `SELECT payment_id, paymongo_payment_id
     FROM payment
     WHERE LOWER(COALESCE(payment_method, '')) = 'qrph'
       AND paymongo_payment_id IN (${placeholders})
     ORDER BY payment_id DESC
     LIMIT 1`,
    references,
  );
  if (!rows.length) return false;

  const payment = rows[0];
  const providerResult = await paymongoService.getQrPhPayment(payment.paymongo_payment_id);
  if (!providerResult.success) {
    const error = new Error(providerResult.error || 'Unable to verify QR Ph payment with PayMongo');
    error.statusCode = 502;
    throw error;
  }

  if (providerResult.data.status === 'paid') {
    await finalizeVerifiedQrPhPayment({
      paymentId: payment.payment_id,
      references: [
        ...references,
        providerResult.data.paymentIntentId,
        providerResult.data.paymongoPaymentId,
      ],
      providerData: providerResult.data,
      io,
    });
  } else if (
    ['failed', 'expired'].includes(providerResult.data.status) ||
    (eventType === 'qrph.expired' && providerResult.data.status === 'pending')
  ) {
    await markQrPhPaymentFailed({
      paymentId: payment.payment_id,
      references: [
        ...references,
        providerResult.data.paymentIntentId,
        providerResult.data.paymongoPaymentId,
      ],
      io,
    });
  }
  return true;
}

exports.handlePayMongoWebhook = async (req, res) => {
  const webhookSecret = process.env.PAYMONGO_WEBHOOK_SECRET;
  const rawBody = Buffer.isBuffer(req.body) ? req.body : null;
  if (!webhookSecret) {
    return res.status(503).json({ success: false, message: 'PayMongo webhook secret is not configured' });
  }
  if (!verifyPayMongoSignature(rawBody, req.get('Paymongo-Signature'), webhookSecret)) {
    return res.status(401).json({ success: false, message: 'Invalid PayMongo webhook signature' });
  }

  try {
    const payload = JSON.parse(rawBody.toString('utf8'));
    const event = payload?.data;
    const eventType = event?.attributes?.type;
    const resource = event?.attributes?.data;
    const resourceId = resource?.id;
    if (!event?.id || !eventType || !resourceId) {
      return res.status(400).json({ success: false, message: 'Malformed PayMongo webhook payload' });
    }

    if (
      [
        'payment.paid',
        'payment.failed',
        'payment_intent.succeeded',
        'payment_intent.payment_failed',
        'payment_intent.awaiting_payment_method',
        'payment_intent.canceled',
        'qrph.expired',
      ].includes(eventType) &&
      await handleQrPhWebhook(eventType, resource, req.app.get('io'))
    ) {
      console.log(`[PayMongo] Webhook ${eventType} processed for QR Ph payment=${resourceId}`);
      return res.status(200).json({ success: true, received: true });
    }

    if (
      eventType === 'payment.paid' ||
      eventType === 'payment.failed' ||
      eventType === 'checkout_session.payment.paid' ||
      eventType === 'checkout_session.payment.failed' ||
      eventType === 'checkout_session.expired'
    ) {
      const providerStatus = ['payment.paid', 'checkout_session.payment.paid'].includes(eventType)
        ? 'paid'
        : 'failed';
      const attributes = resource?.attributes || {};
      const payments = attributes.payments;
      const nestedPayment = Array.isArray(payments) ? payments[0] : payments;
      const providerPaymentId = resource?.type === 'payment' ? resourceId : nestedPayment?.id;
      const paymentReferenceIds = [...new Set([
        providerPaymentId,
        attributes.payment_intent_id,
        typeof attributes.payment_intent === 'string' ? attributes.payment_intent : attributes.payment_intent?.id,
        attributes.checkout_session_id,
        resourceId
      ].filter(Boolean))];
      if (!paymentReferenceIds.length) {
        return res.status(400).json({ success: false, message: 'Webhook has no PayMongo payment ID' });
      }
      const referencePlaceholders = paymentReferenceIds.map(() => '?').join(', ');
      const [result] = await db.query(
        `UPDATE payment p
         LEFT JOIN booking b ON b.booking_id = p.booking_id
         SET p.paymongo_payment_id = ?, p.status = ?
         WHERE p.paymongo_payment_id IN (${referencePlaceholders})
           AND (? <> 'paid' OR b.request_idempotency_key IS NULL OR b.price_confirmation_status IN ('confirmed', 'awaiting_customer', 'accepted', 'declined'))
           AND (? = 'paid' OR LOWER(COALESCE(p.status, '')) NOT IN ('paid', 'success', 'succeeded', 'completed'))`,
        [
          providerPaymentId || resourceId,
          providerStatus,
          ...paymentReferenceIds,
          providerStatus,
          providerStatus
        ]
      );
      console.log(`[PayMongo] Webhook ${eventType} payment=${providerPaymentId || resourceId} updated=${result.affectedRows}`);
      if (providerStatus === 'failed') {
        const [failedBookings] = await db.query(
          `SELECT DISTINCT b.booking_id
           FROM payment p
           INNER JOIN booking b ON b.booking_id = p.booking_id
           WHERE p.paymongo_payment_id IN (${referencePlaceholders})
             AND LOWER(COALESCE(p.payment_method, '')) = 'gcash'
             AND LOWER(COALESCE(p.status, '')) = 'failed'`,
          paymentReferenceIds
        );
        for (const booking of failedBookings) {
          await discardFailedGcashBooking(booking.booking_id);
        }
      }
      if (providerStatus === 'paid') {
        const [paidDrafts] = await db.query(
          `SELECT DISTINCT b.booking_id
           FROM payment p
           INNER JOIN booking b ON b.booking_id = p.booking_id
           WHERE p.paymongo_payment_id = ?
             AND LOWER(COALESCE(p.payment_method, '')) = 'gcash'
             AND LOWER(COALESCE(p.status, '')) = 'paid'
             AND LOWER(COALESCE(b.status, '')) = 'payment_pending'`,
          [providerPaymentId || resourceId]
        );
        for (const booking of paidDrafts) {
          await activatePaidGcashBooking(booking.booking_id, req.app.get('io'));
        }

        const [pickupBookings] = await db.query(
          `SELECT b.booking_id
           FROM payment p
           INNER JOIN booking b ON b.booking_id = p.booking_id
           WHERE p.paymongo_payment_id = ?
             AND LOWER(COALESCE(p.payment_method, '')) = 'gcash'
             AND LOWER(COALESCE(p.status, '')) = 'paid'
             AND LOWER(COALESCE(b.booking_type, '')) IN ('pick up', 'pickup')
             AND LOWER(COALESCE(b.status, '')) <> 'cancelled'`,
          [providerPaymentId || resourceId]
        );
        for (const booking of pickupBookings) {
          try {
            await deliveryController.ensureDeliveryRecord({
              booking_id: booking.booking_id,
              status: 'pending',
              io: req.app.get('io')
            });
          } catch (deliveryError) {
            console.error(`[PayMongo] Failed to finalize paid pickup booking ${booking.booking_id}:`, deliveryError);
            return res.status(500).json({
              success: false,
              message: 'Payment was recorded, but pickup booking finalization needs to retry'
            });
          }
        }

      }
    }

    return res.status(200).json({ success: true, received: true });
  } catch (error) {
    console.error('PayMongo webhook error:', error.message);
    return res.status(error.statusCode || 400).json({
      success: false,
      message: error.statusCode ? error.message : 'Invalid PayMongo webhook payload',
    });
  }
};
// Checkout session redirect handlers (sandbox/test)
exports.checkoutSuccess = async (req, res) => {
  try {
    const sessionId = req.query.session_id || req.query.checkout_session_id;
    if (sessionId) paymongoService.markCheckoutSession(sessionId, 'succeeded');
    res.setHeader('Content-Type', 'text/html');
    return res.send('<html><body><h1>Payment Successful</h1><p>You may close this window.</p></body></html>');
  } catch (e) {
    console.error('checkoutSuccess error:', e);
    return res.status(500).send('Error');
  }
};

exports.checkoutCancel = async (req, res) => {
  try {
    const sessionId = req.query.session_id || req.query.checkout_session_id;
    if (sessionId) {
      paymongoService.markCheckoutSession(sessionId, 'canceled');
    }
    res.setHeader('Content-Type', 'text/html');
    return res.send('<html><body><h1>Payment Canceled</h1><p>You may close this window.</p></body></html>');
  } catch (e) {
    console.error('checkoutCancel error:', e);
    return res.status(500).send('Error');
  }
};
