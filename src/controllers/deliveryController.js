const db = require('../config/db');

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

  try {
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
      ORDER BY d.delivery_time DESC
    `;

    const [results] = await db.query(sql);
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
    res.json({ message: 'Delivery updated successfully' });
  } catch (err) {
    console.error("DB Error (updateDelivery):", err);
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
