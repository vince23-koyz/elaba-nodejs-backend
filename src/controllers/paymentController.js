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

// Get all-time paid sales and monthly breakdown, excluding active or completed refunds.
exports.getShopSales = async (req, res) => {
  const { shopId } = req.params;
  if (!shopId) return res.status(400).json({ success: false, message: 'shopId required' });
  try {
    const eligiblePaymentFilter = `
      p.shop_id = ?
      AND LOWER(p.status) IN ('paid', 'success', 'succeeded', 'completed')
      AND LOWER(COALESCE(b.status, '')) NOT IN ('cancelled', 'canceled', 'declined', 'rejected')
      AND NOT EXISTS (
        SELECT 1
        FROM refund r
        WHERE r.payment_id = p.payment_id
          AND LOWER(COALESCE(r.status, '')) IN ('pending', 'processing', 'succeeded')
      )
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

exports.syncCustomerRefundStatus = async (req, res) => {
  const { bookingId } = req.params;
  const customerId = Number(req.query.customer_id);
  if (!Number.isInteger(customerId) || customerId <= 0) {
    return res.status(400).json({ success: false, message: 'customer_id required' });
  }

  try {
    const [rows] = await db.query(
      `SELECT b.customer_id, r.refund_id, r.paymongo_refund_id, r.amount, r.status
       FROM booking b
       LEFT JOIN payment p ON p.booking_id = b.booking_id
       LEFT JOIN refund r ON r.payment_id = p.payment_id
       WHERE b.booking_id = ?
       ORDER BY r.refund_id DESC
       LIMIT 1`,
      [bookingId]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Booking not found' });
    if (Number(rows[0].customer_id) !== customerId) {
      return res.status(403).json({ success: false, message: 'You are not authorized to view this refund' });
    }

    const refund = rows[0];
    if (!refund.refund_id || !refund.paymongo_refund_id) {
      return res.json({
        success: true,
        refund: refund.refund_id ? {
          refund_id: refund.refund_id,
          amount: Number(refund.amount),
          status: refund.status
        } : null
      });
    }

    const providerResult = await paymongoService.getRefund(refund.paymongo_refund_id);
    if (!providerResult.success) {
      return res.status(502).json({ success: false, message: providerResult.error });
    }

    const providerStatus = providerResult.refund.attributes.status;
    if (providerStatus !== refund.status) {
      await db.query(
        'UPDATE refund SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE refund_id = ?',
        [providerStatus, refund.refund_id]
      );
      const io = req.app.get('io');
      if (io && io.to) {
        io.to(`user_customer_${customerId}`).emit('refundUpdated', {
          bookingId: Number(bookingId),
          refundStatus: providerStatus
        });
      }
    }

    return res.json({
      success: true,
      refund: {
        refund_id: refund.refund_id,
        amount: Number(refund.amount),
        status: providerStatus
      }
    });
  } catch (error) {
    console.error('syncCustomerRefundStatus error:', error);
    return res.status(500).json({ success: false, message: 'Unable to sync refund status' });
  }
};

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
      if (providerStatus === 'paid') {
        const [cancelledBookings] = await db.query(
          `SELECT b.booking_id, b.customer_id
           FROM payment p
           INNER JOIN booking b ON b.booking_id = p.booking_id
           WHERE p.paymongo_payment_id = ?
             AND LOWER(COALESCE(p.payment_method, '')) = 'gcash'
             AND LOWER(COALESCE(p.status, '')) = 'paid'
             AND LOWER(COALESCE(b.status, '')) = 'cancelled'`,
          [providerPaymentId]
        );
        for (const booking of cancelledBookings) {
          try {
            const refundResult = await processBookingRefund({
              bookingId: booking.booking_id,
              reason: 'requested_by_customer',
              notes: 'Automatic refund for cancelled booking',
              requireCancelled: true,
              processWithPayMongo: true
            });
            const io = req.app.get('io');
            if (refundResult.refund && io && io.to) {
              io.to(`user_customer_${booking.customer_id}`).emit('refundUpdated', {
                bookingId: booking.booking_id,
                refundStatus: refundResult.refund.status
              });
            }
            if (!refundResult.success) {
              console.warn(`[PayMongo] Automatic refund failed for cancelled booking ${booking.booking_id}: ${refundResult.message}`);
            }
          } catch (refundError) {
            console.error(`[PayMongo] Automatic refund error for cancelled booking ${booking.booking_id}:`, refundError);
          }
        }
      }
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
