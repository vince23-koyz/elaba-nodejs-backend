// src/controllers/paymentController.js
const db = require("../config/db");

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
    transaction_id
  } = req.body;

  if (!booking_id || !customer_id || !shop_id || !service_id || !payment_method) {
    return res.status(400).json({ message: "booking_id, customer_id, shop_id, service_id and payment_method are required" });
  }

  try {
  // payment status vocabulary: 'pending' | 'paid'
  const statusNorm = (status || 'pending').toString().toLowerCase() === 'paid' ? 'paid' : 'pending';
    const sql = `INSERT INTO payment 
      (booking_id, customer_id, shop_id, service_id, payment_method, amount, status, date, transaction_id) 
      VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), ?)`;

    const amt = amount != null ? Number(amount) : null;
    const txId = transaction_id != null ? Number(transaction_id) : null;

    const [result] = await db.query(sql, [
      booking_id, customer_id, shop_id, service_id, payment_method, amt, statusNorm, txId
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
  const nextStatus = (status || '').toString().toLowerCase() === 'paid' ? 'paid' : 'pending';
    const sql = "UPDATE payment SET status = ? WHERE payment_id = ?";
    const [result] = await db.query(sql, [nextStatus, id]);

    if (result.affectedRows === 0) return res.status(404).json({ message: "Payment not found" });

    // If marking as paid and not yet linked to a transaction, create one and link it
    if (nextStatus === 'paid') {
      // 1) Read current payment row
      const [rows] = await db.query(
        "SELECT amount, transaction_id, booking_id FROM payment WHERE payment_id = ?",
        [id]
      );
      const paymentRow = rows && rows[0] ? rows[0] : null;
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
      "SELECT COALESCE(SUM(amount), 0) AS total FROM payment WHERE shop_id = ? AND status = 'paid' AND transaction_id IS NOT NULL",
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
    res.json({ success: true, status: result.status, data: result.data });
  } catch (e) {
    console.error('checkPaymentStatus error:', e);
    res.status(500).json({ success: false, message: e.message || 'Server error' });
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
