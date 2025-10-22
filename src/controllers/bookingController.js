const db = require('../config/db'); 

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
                      p.payment_id, p.payment_method, p.status AS payment_status, p.date
               FROM booking b
               JOIN shop s ON b.shop_id = s.shop_id
               JOIN customer c ON b.customer_id = c.customer_id
               LEFT JOIN payment p ON b.booking_id = p.booking_id`;
    
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

// UPDATE Booking Status Only
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

// UPDATE Booking Date (Reschedule)
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
    // delete payment first then booking (foreign key safe)
    await db.query('DELETE FROM payment WHERE booking_id = ?', [id]);
    
    const [result] = await db.query('DELETE FROM booking WHERE booking_id = ?', [id]);
    
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Booking not found' });
    res.json({ message: 'Booking and payment deleted successfully' });
  } catch (err) {
    console.error("DB Error (deleteBooking):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};
