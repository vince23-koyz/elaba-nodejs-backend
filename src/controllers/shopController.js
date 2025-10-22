// controllers/shopController.js
const db = require('../config/db');

// CREATE Shop
exports.createShop = async (req, res) => {
  const { name, address, website, owner_name, operation_hours, admin_id, status } = req.body;

  // For superadmin, admin_id is optional
  // Handle image upload
  const logo = req.file ? `/uploads/shop-images/${req.file.filename}` : '';
  const shopStatus = status || 'active';

  try {
    let sql, params;
    
    if (admin_id) {
      sql = "INSERT INTO shop (name, address, website, owner_name, operation_hours, admin_id, logo, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
      params = [name, address, website, owner_name, operation_hours, admin_id, logo, shopStatus];
    } else {
      sql = "INSERT INTO shop (name, address, website, owner_name, operation_hours, logo, status) VALUES (?, ?, ?, ?, ?, ?, ?)";
      params = [name, address, website, owner_name, operation_hours, logo, shopStatus];
    }
    
    const [result] = await db.query(sql, params);

    res.status(201).json({
      success: true,
      message: "Shop created successfully",
      shop_id: result.insertId,
      logo: logo
    });
  } catch (err) {
    console.error("DB Error (createShop):", err);
    res.status(500).json({ error: err.message });
  }
};

// GET ALL Shops
exports.getShops = async (req, res) => {
  try {
    const [results] = await db.query('SELECT * FROM shop');
    res.json(results);
  } catch (err) {
    console.error("DB Error (getShops):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

// GET Shop by ID
exports.getShopById = async (req, res) => {
  const { id } = req.params;
  try {
    const [results] = await db.query('SELECT * FROM shop WHERE shop_id = ?', [id]);

    if (results.length === 0) return res.status(404).json({ message: 'Shop not found' });
    res.json(results[0]);
  } catch (err) {
    console.error("DB Error (getShopById):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

// Get shop by admin_id
exports.getShopByAdmin = async (req, res) => {
  const { admin_id } = req.params;
  try {
    const [results] = await db.query('SELECT * FROM shop WHERE admin_id = ? LIMIT 1', [admin_id]);

    if (results.length === 0) {
      return res.json({ shop: null });
    }
    res.json({ shop: results[0] });
  } catch (err) {
    console.error("DB Error (getShopByAdmin):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

// UPDATE Shop
exports.updateShop = async (req, res) => {
  const { id } = req.params;
  const { name, address, website, owner_name, operation_hours, status } = req.body;

  console.log('Updating shop ID:', id);
  console.log('Request body:', req.body);
  console.log('Has file:', !!req.file);

  try {
    let sql, params;

    // Handle image upload - use same column as RegisterShop (logo)
    if (req.file) {
      const logoPath = `/uploads/shop-images/${req.file.filename}`;
      console.log('Updating with image:', logoPath);
      sql = `UPDATE shop 
             SET name=?, address=?, website=?, owner_name=?, operation_hours=?, logo=?
             WHERE shop_id=?`;
      params = [name, address, website, owner_name, operation_hours, logoPath, id];
    } else {
      console.log('Updating without image');
      sql = `UPDATE shop 
             SET name=?, address=?, website=?, owner_name=?, operation_hours=?
             WHERE shop_id=?`;
      params = [name, address, website, owner_name, operation_hours, id];
    }

    console.log('Executing SQL:', sql);
    console.log('With params:', params);

    const [result] = await db.query(sql, params);
    console.log('Update result:', result);

    if (result.affectedRows === 0) return res.status(404).json({ message: 'Shop not found' });
    
    const responseData = { message: 'Shop updated successfully' };
    if (req.file) {
      responseData.logo = `/uploads/shop-images/${req.file.filename}`;
    }
    
    console.log('Sending response:', responseData);
    res.json(responseData);
  } catch (err) {
    console.error("DB Error (updateShop):", err);
    console.error("Error details:", {
      message: err.message,
      code: err.code,
      errno: err.errno,
      sqlState: err.sqlState,
      sqlMessage: err.sqlMessage
    });
    res.status(500).json({ message: 'Database error', error: err.message, details: err });
  }
};

// DELETE Shop
exports.deleteShop = async (req, res) => {
  const { id } = req.params;
  try {
    const [result] = await db.query('DELETE FROM shop WHERE shop_id = ?', [id]);

    if (result.affectedRows === 0) return res.status(404).json({ message: 'Shop not found' });
    res.json({ message: 'Shop deleted successfully' });
  } catch (err) {
    console.error("DB Error (deleteShop):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};
