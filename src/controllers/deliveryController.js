// controllers/deliveryController.js
const db = require('../config/db');

// CREATE Delivery
exports.createDelivery = (req, res) => {
  const { pickup_address, delivery_address, delivery_time, status } = req.body;

  const sql = `INSERT INTO delivery (pickup_address, delivery_address, delivery_time, status) 
               VALUES (?, ?, ?, ?)`;

  db.query(sql, [pickup_address, delivery_address, delivery_time, status], (err, result) => {
    if (err) return res.status(500).json({ message: 'Database error', error: err });

    res.status(201).json({
      message: 'Delivery created successfully',
      delivery_id: result.insertId
    });
  });
};

// GET ALL Deliveries
exports.getDeliveries = (req, res) => {
  db.query('SELECT * FROM delivery', (err, results) => {
    if (err) return res.status(500).json({ message: 'Database error', error: err });
    res.json(results);
  });
};

// GET Delivery by ID
exports.getDeliveryById = (req, res) => {
  const { id } = req.params;

  db.query('SELECT * FROM delivery WHERE delivery_id = ?', [id], (err, results) => {
    if (err) return res.status(500).json({ message: 'Database error', error: err });
    if (results.length === 0) return res.status(404).json({ message: 'Delivery not found' });

    res.json(results[0]);
  });
};

// UPDATE Delivery
exports.updateDelivery = (req, res) => {
  const { id } = req.params;
  const { pickup_address, delivery_address, delivery_time, status } = req.body;

  const sql = `UPDATE delivery 
               SET pickup_address=?, delivery_address=?, delivery_time=?, status=? 
               WHERE delivery_id=?`;

  db.query(sql, [pickup_address, delivery_address, delivery_time, status, id], (err, result) => {
    if (err) return res.status(500).json({ message: 'Database error', error: err });
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Delivery not found' });

    res.json({ message: 'Delivery updated successfully' });
  });
};

// DELETE Delivery
exports.deleteDelivery = (req, res) => {
  const { id } = req.params;

  db.query('DELETE FROM delivery WHERE delivery_id = ?', [id], (err, result) => {
    if (err) return res.status(500).json({ message: 'Database error', error: err });
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Delivery not found' });

    res.json({ message: 'Delivery deleted successfully' });
  });
};
