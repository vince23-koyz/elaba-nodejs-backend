// eLaba-backend/src/controllers/serviceController.js
const db = require('../config/db');

// CREATE Service
exports.createService = async (req, res) => {
  console.log("REQ.BODY:", req.body);

  const { offers, quantity, description, price, package, shop_id, status } = req.body;

  if (!shop_id) {
    return res.status(400).json({ message: "Shop ID is required" });
  }

  try {
    const sql = "INSERT INTO services (offers, quantity, description, price, package, shop_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)";
    const [result] = await db.query(sql, [offers, quantity, description, price, package, shop_id, status]);

    res.status(201).json({ 
      success: true,
      message: "Service added successfully", 
      service_id: result.insertId
    });
  } catch (err) {
    console.error("DB Error (createService):", err);
    res.status(500).json({ error: err.message });
  }
};

// GET ALL Services
exports.getServices = async (req, res) => {
  try {
    const [results] = await db.query('SELECT * FROM services');
    res.json(results);
  } catch (err) {
    console.error("DB Error (getServices):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

// GET Service by ID
exports.getServiceById = async (req, res) => {
  const { id } = req.params;

  try {
    const [results] = await db.query('SELECT * FROM services WHERE service_id = ?', [id]);
    
    if (results.length === 0) return res.status(404).json({ message: 'Service not found' });
    res.json(results[0]);
  } catch (err) {
    console.error("DB Error (getServiceById):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

// GET Services by Shop ID
exports.getServicesByShop = async (req, res) => {
  const { shop_id } = req.params;

  if (!shop_id) {
    return res.status(400).json({ message: "Shop ID is required" });
  }

  try {
    const sql = "SELECT * FROM services WHERE shop_id = ?";
    const [results] = await db.query(sql, [shop_id]);
    
    if (results.length === 0) return res.status(404).json({ message: 'No services found for this shop' });
    res.json(results);
  } catch (err) {
    console.error("DB Error (getServicesByShop):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

// UPDATE Service
exports.updateService = async (req, res) => {
  const { id } = req.params;
  const { offers, quantity, description, price, package, status } = req.body;

  try {
    const sql = `UPDATE services 
                SET offers=?, quantity=?, description=?, price=?, package=?, status=? 
                WHERE service_id=?`;

    const [result] = await db.query(sql, [offers, quantity, description, price, package, status, id]);
    
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Service not found' });
    res.json({ message: 'Service updated successfully' });
  } catch (err) {
    console.error("DB Error (updateService):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

// DELETE Service
exports.deleteService = async (req, res) => {
  const { id } = req.params;

  try {
    const [result] = await db.query('DELETE FROM services WHERE service_id = ?', [id]);
    
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Service not found' });
    res.json({ message: 'Service deleted successfully' });
  } catch (err) {
    console.error("DB Error (deleteService):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};
