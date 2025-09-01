// eLaba-backend/src/controllers/serviceController.js
const db = require('../config/db');

// CREATE Service
exports.createService = (req, res) => {
  console.log("REQ.BODY:", req.body);

  const { offers, quantity, description, price, package, shop_id, status } = req.body;

  if (!shop_id) {
    return res.status(400).json({ message: "Shop ID is required" });
  }

  const sql = "INSERT INTO services (offers, quantity, description, price, package, shop_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)";
  db.query(sql, [offers, quantity, description, price, package, shop_id, status], (err, result) => {
    if (err) return res.status(500).json({ error: err });

    res.status(201).json({ 
      success: true,
      message: "Service added successfully", 
      service_id: result.insertId
    });
  });
};

// GET ALL Services
exports.getServices = (req, res) => {
  db.query('SELECT * FROM services', (err, results) => {
    if (err) return res.status(500).json({ message: 'Database error', error: err });
    res.json(results);
  });
};

// GET Service by ID
exports.getServiceById = (req, res) => {
  const { id } = req.params;

  db.query('SELECT * FROM services WHERE service_id = ?', [id], (err, results) => {
    if (err) return res.status(500).json({ message: 'Database error', error: err });
    if (results.length === 0) return res.status(404).json({ message: 'Service not found' });

    res.json(results[0]);
  });
};

// GET Services by Shop ID
exports.getServicesByShop = (req, res) => {
  const { shop_id } = req.params;

  if (!shop_id) {
    return res.status(400).json({ message: "Shop ID is required" });
  }

  const sql = "SELECT * FROM services WHERE shop_id = ?";
  db.query(sql, [shop_id], (err, results) => {
    if (err) return res.status(500).json({ message: 'Database error', error: err });
    if (results.length === 0) return res.status(404).json({ message: 'No services found for this shop' });

    res.json(results);
  });
};

// UPDATE Service
exports.updateService = (req, res) => {
  const { id } = req.params;
  const { offers, quantity, description, price, package, status } = req.body;

  const sql = `UPDATE services 
              SET offers=?, quantity=?, description=?, price=?, package=?, status=? 
              WHERE service_id=?`;

  db.query(sql, [offers, quantity, description, price, package, status, id], (err, result) => {
    if (err) return res.status(500).json({ message: 'Database error', error: err });
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Service not found' });

    res.json({ message: 'Service updated successfully' });
  });
};

// DELETE Service
exports.deleteService = (req, res) => {
  const { id } = req.params;

  db.query('DELETE FROM services WHERE service_id = ?', [id], (err, result) => {
    if (err) return res.status(500).json({ message: 'Database error', error: err });
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Service not found' });

    res.json({ message: 'Service deleted successfully' });
  });
};
