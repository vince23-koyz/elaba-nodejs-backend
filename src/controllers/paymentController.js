// src/controllers/paymentController.js
const db = require("../config/db");

// Get all payments
exports.getPayments = (req, res) => {
  db.query("SELECT * FROM payment", (err, result) => {
    if (err) return res.status(500).json({ message: "Database error", error: err });
    res.json(result);
  });
};

// Get payment by ID
exports.getPaymentById = (req, res) => {
  const { id } = req.params;
  db.query("SELECT * FROM payment WHERE payment_id = ?", [id], (err, result) => {
    if (err) return res.status(500).json({ message: "Database error", error: err });
    if (result.length === 0) return res.status(404).json({ message: "Payment not found" });
    res.json(result[0]);
  });
};

// CREATE Payment
exports.createPayment = (req, res) => {
  const { booking_id, customer_id, shop_id, service_id, payment_method, status } = req.body;

  if (!booking_id || !customer_id || !shop_id || !service_id || !payment_method || !status) {
    return res.status(400).json({ message: "All fields are required" });
  }

  const sql = `INSERT INTO payment 
    (booking_id, customer_id, shop_id, service_id, payment_method, status, date) 
    VALUES (?, ?, ?, ?, ?, ?, NOW())`;

  db.query(sql, [booking_id, customer_id, shop_id, service_id, payment_method, status], (err, result) => {
    if (err) {
      console.error("Payment DB Error:", err);
      return res.status(500).json({ message: "Database error", error: err });
    }

    res.status(201).json({
      message: "Payment created successfully",
      payment_id: result.insertId,
    });
  });
};

// Update payment status
exports.updatePaymentStatus = (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!status) return res.status(400).json({ message: "Status is required" });

  const sql = "UPDATE payment SET Status = ? WHERE payment_id = ?";
  db.query(sql, [status, id], (err, result) => {
    if (err) return res.status(500).json({ message: "Database error", error: err });
    if (result.affectedRows === 0) return res.status(404).json({ message: "Payment not found" });

    res.json({ message: "Payment status updated successfully" });
  });
};
