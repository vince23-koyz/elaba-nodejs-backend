// shopController.js
const mysql = require('mysql2');
const bcrypt = require('bcryptjs');
// controllers/shopController.js
const db = require('../config/db');

// CREATE Shop
exports.createShop = (req, res) => {
  const { name, address, website, owner_name, operation_hours, admin_id } = req.body;

  if (!admin_id) {
    return res.status(400).json({ message: "Admin ID is required" });
  }

  const sql = "INSERT INTO shop (name, address, website, owner_name, operation_hours, admin_id) VALUES (?, ?, ?, ?, ?, ?)";
  db.query(sql, [name, address, website, owner_name, operation_hours, admin_id], (err, result) => {
    if (err) return res.status(500).json({ error: err });

    res.status(201).json({ 
      success: true,
      message: "Shop created successfully",
      shop_id: result.insertId 
    });
  });
};

// GET ALL Shops
exports.getShops = (req, res) => {
  db.query('SELECT * FROM shop', (err, results) => {
    if (err) return res.status(500).json({ message: 'Database error', error: err });
    res.json(results);
  });
};

// GET Shop by ID
exports.getShopById = (req, res) => {
  const { id } = req.params;

  db.query('SELECT * FROM shop WHERE shop_id = ?', [id], (err, results) => {
    if (err) return res.status(500).json({ message: 'Database error', error: err });
    if (results.length === 0) return res.status(404).json({ message: 'Shop not found' });

    res.json(results[0]);
  });
};

// Get shop by admin_id
exports.getShopByAdmin = (req, res) => {
  const { admin_id } = req.params;

  const sql = 'SELECT * FROM shop WHERE admin_id = ? LIMIT 1';
  db.query(sql, [admin_id], (err, results) => {
    if (err) {
      console.log(err);
      return res.status(500).json({ message: 'Database error', error: err });
    }

    if (results.length === 0) {
      return res.json({ shop: null });
    }

    res.json({ shop: results[0] });
  });
};

// UPDATE Shop
exports.updateShop = (req, res) => {
  const { id } = req.params;
  const { name, address, website, owner_name, operation_hours } = req.body;

  const sql = `UPDATE shop 
               SET name=?, address=?, website=?, owner_name=?, operation_hours=? 
               WHERE shop_id=?`;

  db.query(sql, [name, address, website, owner_name, operation_hours, id], (err, result) => {
    if (err) return res.status(500).json({ message: 'Database error', error: err });
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Shop not found' });

    res.json({ message: 'Shop updated successfully' });
  });
};

// DELETE Shop
exports.deleteShop = (req, res) => {
  const { id } = req.params;

  db.query('DELETE FROM shop WHERE shop_id = ?', [id], (err, result) => {
    if (err) return res.status(500).json({ message: 'Database error', error: err });
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Shop not found' });

    res.json({ message: 'Shop deleted successfully' });
  });
};
