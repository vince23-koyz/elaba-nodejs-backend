const db = require('../config/db'); 

// CREATE Booking
exports.createBooking = (req, res) => {
  const { booking_type, booking_date, status, total_amount, shop_id, service_id, customer_id } = req.body;

  // Debug log
  console.log('Create Booking:', req.body);

  // Validate required fields
  if (!booking_type || !booking_date || !status || !total_amount || !shop_id || !service_id || !customer_id) {
    return res.status(400).json({ message: 'All fields are required' });
  }

  const sql = `INSERT INTO booking (booking_type, booking_date, status, total_amount, shop_id, service_id, customer_id) 
               VALUES (?, ?, ?, ?, ?, ?, ?)`;

  db.query(sql, [booking_type, booking_date, status, total_amount, shop_id, service_id, customer_id], (err, result) => {
    if (err) {
      console.error('Booking DB Error:', err);
      return res.status(500).json({ message: 'Database error', error: err });
    }

    res.status(201).json({
      message: 'Booking created successfully',
      booking_id: result.insertId
    });
  });
};

// CREATE Payment (linked to booking)
exports.createPayment = (req, res) => {
  const { booking_id, customer_id, shop_id, service_id, payment_method, status } = req.body;

  if (!booking_id || !customer_id || !shop_id || !service_id || !payment_method || !status) {
    return res.status(400).json({ message: "All fields are required" });
  }

  const sql = `INSERT INTO payment 
    (booking_id, customer_id, shop_id, service_id, payment_method, status, date) 
    VALUES (?, ?, ?, ?, ?, ?, NOW())`;

  db.query(
    sql,
    [booking_id, customer_id, shop_id, service_id, payment_method, status],
    (err, result) => {
      if (err) {
        console.error("Payment DB Error:", err);
        return res.status(500).json({ message: "Database error", error: err });
      }

      res.status(201).json({
        message: "Payment created successfully",
        payment_id: result.insertId,
      });
    }
  );
};

// GET ALL Bookings (with payment info if any)
exports.getBookings = (req, res) => {
  const { shop_id } = req.query; // Get shop_id from query parameters
  
  let sql = `SELECT b.booking_id, b.booking_type, b.booking_date, b.status AS booking_status, b.total_amount, 
                    b.shop_id, s.name AS shop_name, c.first_name AS customer_first_name, c.last_name AS customer_last_name,
                    p.payment_id, p.payment_method, p.status AS payment_status, p.date
             FROM booking b
             JOIN shop s ON b.shop_id = s.shop_id
             JOIN customer c ON b.customer_id = c.customer_id
             LEFT JOIN payment p ON b.booking_id = p.booking_id`;
  
  let queryParams = [];
  
  // Add filter for shop_id if provided
  if (shop_id) {
    sql += ` WHERE b.shop_id = ?`;
    queryParams.push(shop_id);
  }
  
  // Order by booking date (newest first)
  sql += ` ORDER BY b.booking_date DESC`;

  db.query(sql, queryParams, (err, results) => {
    if (err) return res.status(500).json({ message: 'Database error', error: err });
    res.json(results);
  });
};

// GET Booking by ID (with payment)
exports.getBookingById = (req, res) => {
  const { id } = req.params;

  const sql = `SELECT b.booking_id, b.booking_type, b.booking_date, b.status AS booking_status, b.total_amount, 
                      s.name AS shop_name, c.first_name AS customer_first_name, c.last_name AS customer_last_name,
                      p.payment_id, p.payment_method, p.status AS payment_status, p.date
               FROM booking b
               JOIN shop s ON b.shop_id = s.shop_id
               JOIN customer c ON b.customer_id = c.customer_id
               LEFT JOIN payment p ON b.booking_id = p.booking_id
               WHERE b.booking_id = ?`;

  db.query(sql, [id], (err, results) => {
    if (err) return res.status(500).json({ message: 'Database error', error: err });
    if (results.length === 0) return res.status(404).json({ message: 'Booking not found' });

    res.json(results[0]);
  });
};

// UPDATE Booking Status Only
exports.updateBookingStatus = (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!status) {
    return res.status(400).json({ message: 'Status is required' });
  }

  const sql = `UPDATE booking SET status = ? WHERE booking_id = ?`;

  db.query(sql, [status, id], (err, result) => {
    if (err) {
      console.error('Update booking status error:', err);
      return res.status(500).json({ message: 'Database error', error: err });
    }
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Booking not found' });
    }

    res.json({ 
      message: 'Booking status updated successfully',
      booking_id: id,
      new_status: status
    });
  });
};

// UPDATE Booking
exports.updateBooking = (req, res) => {
  const { id } = req.params;
  const { booking_type, booking_date, status, total_amount, shop_id, service_id, customer_id } = req.body;

  if (!booking_type || !booking_date || !status || !total_amount || !shop_id || !service_id || !customer_id) {
    return res.status(400).json({ message: 'All fields are required' });
  }

  const sql = `UPDATE booking 
               SET booking_type=?, booking_date=?, status=?, total_amount=?, 
                   shop_id=?, service_id=?, customer_id=? 
               WHERE booking_id=?`;

  db.query(sql, [booking_type, booking_date, status, total_amount, shop_id, service_id, customer_id, id], (err, result) => {
    if (err) return res.status(500).json({ message: 'Database error', error: err });
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Booking not found' });

    res.json({ message: 'Booking updated successfully' });
  });
};

// DELETE Booking (and its payment if any)
exports.deleteBooking = (req, res) => {
  const { id } = req.params;

  // delete payment first then booking (foreign key safe)
  db.query('DELETE FROM payment WHERE booking_id = ?', [id], (err) => {
    if (err) return res.status(500).json({ message: 'Database error', error: err });

    db.query('DELETE FROM booking WHERE booking_id = ?', [id], (err2, result) => {
      if (err2) return res.status(500).json({ message: 'Database error', error: err2 });
      if (result.affectedRows === 0) return res.status(404).json({ message: 'Booking not found' });

      res.json({ message: 'Booking and payment deleted successfully' });
    });
  });
};
