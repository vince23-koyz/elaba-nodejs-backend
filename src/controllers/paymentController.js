// src/controllers/paymentController.js
const db = require("../config/db");
const crypto = require('crypto');
const { sendNotification } = require('../service/notificationService');

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

exports.getRefunds = async (req, res) => {
  try {
    const [refundRows] = await db.query(`
      SELECT refund_id, paymongo_refund_id, status
      FROM refund
      WHERE paymongo_refund_id IS NOT NULL
        AND LOWER(COALESCE(status, '')) IN ('pending', 'processing')
    `);
    for (const refund of refundRows) {
      try {
        const providerResult = await paymongoService.getRefund(refund.paymongo_refund_id);
        if (providerResult.success) {
          const providerStatus = providerResult.refund.attributes.status;
          if (providerStatus !== refund.status) {
            await db.query(
              'UPDATE refund SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE refund_id = ?',
              [providerStatus, refund.refund_id]
            );
          }
        }
      } catch (syncError) {
        console.warn(`[PayMongo] Could not sync refund ${refund.refund_id}:`, syncError.message);
      }
    }

    const [rows] = await db.query(`
      SELECT r.refund_id, r.paymongo_refund_id, r.payment_id, r.booking_id,
             r.amount, r.reason, r.notes, r.status, r.created_at, r.updated_at,
             p.payment_method, p.status AS payment_status, p.paymongo_payment_id,
             b.status AS booking_status, b.total_amount,
             c.first_name AS customer_first_name, c.last_name AS customer_last_name,
             s.name AS shop_name
      FROM refund r
      INNER JOIN payment p ON p.payment_id = r.payment_id
      INNER JOIN booking b ON b.booking_id = r.booking_id
      LEFT JOIN customer c ON c.customer_id = b.customer_id
      LEFT JOIN shop s ON s.shop_id = b.shop_id
      ORDER BY r.created_at DESC, r.refund_id DESC
    `);
    return res.json({ success: true, refunds: rows });
  } catch (error) {
    console.error('getRefunds error:', error);
    return res.status(500).json({ success: false, message: 'Unable to load refunds' });
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

  if (!status) return res.status(400).json({ message: "Status is required" });

  try {
  // normalize status to only 'paid' | 'pending'
  const normalizedStatus = (status || '').toString().toLowerCase();
  const nextStatus = ['paid', 'success', 'succeeded', 'completed'].includes(normalizedStatus) ? 'paid' : 'pending';
    const sql = "UPDATE payment SET status = ? WHERE payment_id = ?";
    const [result] = await db.query(sql, [nextStatus, id]);

    if (result.affectedRows === 0) return res.status(404).json({ message: "Payment not found" });

    let paymentRow = null;

    // Read the payment row once so we can emit the latest booking/payment state
    const [rows] = await db.query(
      "SELECT amount, transaction_id, booking_id, customer_id, payment_method FROM payment WHERE payment_id = ?",
      [id]
    );
    paymentRow = rows && rows[0] ? rows[0] : null;

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

// Get total paid sales for a shop (sum of payment.amount where status = 'paid')
exports.getShopSales = async (req, res) => {
  const { shopId } = req.params;
  if (!shopId) return res.status(400).json({ success: false, message: 'shopId required' });
  try {
    const [rows] = await db.query(
      "SELECT COALESCE(SUM(p.amount), 0) AS total FROM payment p INNER JOIN booking b ON b.booking_id = p.booking_id WHERE p.shop_id = ? AND LOWER(p.status) IN ('paid', 'success', 'succeeded', 'completed') AND LOWER(COALESCE(b.status, '')) NOT IN ('cancelled', 'canceled', 'rejected')",
      [shopId]
    );
    const total = rows && rows[0] ? Number(rows[0].total || 0) : 0;
    return res.json({ success: true, total });
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
const { processBookingRefund } = require('./bookingController');

exports.createGCashPayment = async (req, res) => {
  const { amount, description, customerInfo, bookingId } = req.body;
  if (!amount || !description || !customerInfo) {
    return res.status(400).json({ success: false, message: 'Amount, description and customerInfo required' });
  }
  try {
    const result = await paymongoService.createGCashPayment(amount, description, customerInfo, bookingId);
    if (!result.success) {
      return res.status(400).json({ success: false, message: result.error || 'Payment creation failed' });
    }
    res.json({ success: true, data: result.data, mode: paymongoService.mode, message: 'GCash payment created' });
  } catch (e) {
    console.error('createGCashPayment error:', e);
    res.status(500).json({ success: false, message: e.message || 'Server error' });
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

exports.syncRefundStatus = async (req, res) => {
  const { refundId } = req.params;
  if (!refundId) return res.status(400).json({ success: false, message: 'refundId required' });

  try {
    const [rows] = await db.query(`
      SELECT r.refund_id, r.paymongo_refund_id, r.payment_id, r.booking_id,
             r.amount, r.status, b.customer_id
      FROM refund r
      INNER JOIN booking b ON b.booking_id = r.booking_id
      WHERE r.refund_id = ?
      LIMIT 1
    `, [refundId]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'Refund not found' });

    const localRefund = rows[0];
    if (!localRefund.paymongo_refund_id) {
      return res.status(400).json({ success: false, message: 'Refund has no PayMongo refund ID' });
    }
    const providerResult = await paymongoService.getRefund(localRefund.paymongo_refund_id);
    if (!providerResult.success) {
      return res.status(502).json({ success: false, message: providerResult.error });
    }

    const nextStatus = providerResult.refund.attributes.status;
    const previousStatus = String(localRefund.status || '').toLowerCase();
    await db.query(
      'UPDATE refund SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE refund_id = ?',
      [nextStatus, refundId]
    );

    if (nextStatus !== previousStatus && ['succeeded', 'failed'].includes(nextStatus) && localRefund.customer_id) {
      const title = nextStatus === 'succeeded' ? 'Refund Successful' : 'Refund Failed';
      const message = nextStatus === 'succeeded'
        ? `Your refund for booking #${localRefund.booking_id} was successful.`
        : `Your refund for booking #${localRefund.booking_id} failed. Please contact support.`;
      const { savedNotification } = await sendNotification({
        accountId: localRefund.customer_id,
        accountType: 'customer',
        bookingId: localRefund.booking_id,
        title,
        message,
        replaceExisting: true,
        existingTitles: ['Refund Processing', 'Refund Successful', 'Refund Failed']
      });
      const io = req.app.get('io');
      if (io && savedNotification) {
        io.to(`user_customer_${localRefund.customer_id}`).emit('newNotification', savedNotification);
      }
    }

    return res.json({
      success: true,
      refund: {
        refund_id: localRefund.refund_id,
        paymongo_refund_id: localRefund.paymongo_refund_id,
        amount: Number(localRefund.amount),
        status: nextStatus
      }
    });
  } catch (error) {
    console.error('syncRefundStatus error:', error);
    return res.status(500).json({ success: false, message: 'Unable to sync refund status' });
  }
};

exports.createBookingRefund = async (req, res) => {
  const { booking_id, customer_id, reason = null, notes } = req.body;
  if (!booking_id) return res.status(400).json({ success: false, message: 'booking_id required' });

  try {
    const result = await processBookingRefund({
      bookingId: booking_id,
      customerId: customer_id,
      reason,
      notes,
      requireCancelled: true,
      processWithPayMongo: false
    });
    if (!result.success) {
      return res.status(result.code || 400).json({
        success: false,
        message: result.message || 'Refund could not be processed',
        refund: result.refund || null
      });
    }
    return res.status(result.duplicate ? 200 : 201).json({
      success: true,
      message: result.duplicate ? 'Refund already exists' : 'Refund request created',
      refund: result.refund || null
    });
  } catch (error) {
    console.error('createBookingRefund error:', error);
    return res.status(500).json({ success: false, message: 'Unable to create refund request' });
  }
};

exports.processExistingRefund = async (req, res) => {
  const { refundId } = req.params;
  const { customer_id: customerId, reason = 'requested_by_customer', notes = null } = req.body || {};
  if (!refundId) return res.status(400).json({ success: false, message: 'refundId required' });
  const allowedReasons = new Set(['duplicate', 'fraudulent', 'requested_by_customer', 'others']);
  if (!allowedReasons.has(reason)) {
    return res.status(400).json({ success: false, message: 'Invalid PayMongo refund reason' });
  }

  try {
    const [rows] = await db.query(
      'SELECT r.booking_id, b.customer_id FROM refund r INNER JOIN booking b ON b.booking_id = r.booking_id WHERE r.refund_id = ? LIMIT 1',
      [refundId]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Refund request not found' });
    if (customerId != null && Number(rows[0].customer_id) !== Number(customerId)) {
      return res.status(403).json({ success: false, message: 'You are not authorized to process this refund' });
    }

    const result = await processBookingRefund({
      bookingId: rows[0].booking_id,
      customerId: customerId ?? null,
      reason,
      notes,
      requireCancelled: true,
      processWithPayMongo: true
    });
    if (!result.success) {
      return res.status(result.code || 400).json({ success: false, message: result.message, refund: result.refund || null });
    }
    const io = req.app.get('io');
    if (io && io.to) {
      io.to(`user_customer_${rows[0].customer_id}`).emit('refundUpdated', {
        bookingId: rows[0].booking_id,
        refundStatus: result.refund?.status || 'succeeded',
      });
    }
    return res.json({ success: true, message: 'Refund sent to PayMongo', refund: result.refund });
  } catch (error) {
    console.error('processExistingRefund error:', error);
    return res.status(500).json({
      success: false,
      message: error?.message || 'Unable to process refund'
    });
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
  const expectedSignature = process.env.PAYMONGO_MODE === 'test' ? parts.te : parts.li;
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

    if (eventType === 'payment.paid' || eventType === 'payment.failed' || eventType === 'checkout_session.payment.paid') {
      const providerStatus = ['payment.paid', 'checkout_session.payment.paid'].includes(eventType)
        ? 'paid'
        : 'pending';
      const nestedPayment = resource?.attributes?.payments?.[0];
      const providerPaymentId = resource?.type === 'payment' ? resourceId : nestedPayment?.id;
      if (!providerPaymentId) {
        return res.status(400).json({ success: false, message: 'Webhook has no PayMongo payment ID' });
      }
      const [result] = await db.query(
        `UPDATE payment
         SET paymongo_payment_id = ?, status = ?
         WHERE paymongo_payment_id IN (?, ?, ?)
         `,
        [
          providerPaymentId,
          providerPaymentId,
          resource?.attributes?.payment_intent_id || resource?.attributes?.payment_intent?.id || resourceId
        ]
      );
      console.log(`[PayMongo] Webhook ${eventType} payment=${providerPaymentId} updated=${result.affectedRows}`);
    } else if (eventType === 'refund.succeeded' || eventType === 'refund.failed' || eventType === 'refund.processing') {
      const refundStatus = eventType.replace('refund.', '');
      const [result] = await db.query(
        'UPDATE refund SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE paymongo_refund_id = ?',
        [refundStatus, resourceId]
      );
      const [refundRows] = await db.query(
        `SELECT r.booking_id, b.customer_id
         FROM refund r
         INNER JOIN booking b ON b.booking_id = r.booking_id
         WHERE r.paymongo_refund_id = ?
         LIMIT 1`,
        [resourceId]
      );
      const io = req.app.get('io');
      if (io && io.to && refundRows[0]) {
        io.to(`user_customer_${refundRows[0].customer_id}`).emit('refundUpdated', {
          bookingId: refundRows[0].booking_id,
          refundStatus,
        });
      }
      console.log(`[PayMongo] Webhook ${eventType} refund=${resourceId} updated=${result.affectedRows}`);
    }

    return res.status(200).json({ success: true, received: true });
  } catch (error) {
    console.error('PayMongo webhook error:', error.message);
    return res.status(400).json({ success: false, message: 'Invalid PayMongo webhook payload' });
  }
};
// Checkout session redirect handlers (sandbox/test)
exports.checkoutSuccess = async (req, res) => {
  try {
    const sessionId = req.query.session_id;
    const piId = req.query.pi_id;
    if (sessionId) paymongoService.markCheckoutSession(sessionId, 'succeeded');
    // For Payment Intent return_url, we don't need to mark anything; the app will verify via API
    // Simple success page for WebView detection
    res.setHeader('Content-Type', 'text/html');
    return res.send('<html><body><h1>Payment Successful</h1><p>You may close this window.</p></body></html>');
  } catch (e) {
    console.error('checkoutSuccess error:', e);
    return res.status(500).send('Error');
  }
};

exports.checkoutCancel = async (req, res) => {
  try {
    const sessionId = req.query.session_id;
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
