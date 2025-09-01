//adminController.js
const bcrypt = require('bcryptjs');
const db = require('../config/db'); // Use the shared db connection

// REGISTER ADMIN
exports.registerAdmin = async (req, res) => {
  const { first_name, last_name, street, zone, barangay, city, phone_number, password } = req.body;

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    const sql = `INSERT INTO admin 
      (first_name, last_name, street, zone, barangay, city, phone_number, password)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

    db.query(sql, [first_name, last_name, street, zone, barangay, city, phone_number, hashedPassword], (err, result) => {
      if (err) {
        console.log(err);
        if (err.code === "ER_DUP_ENTRY") {
          return res.status(400).json({ message: 'Phone number already registered' });
        }
        return res.status(500).json({ message: 'Database error', error: err });
      }

      res.status(201).json({ message: 'Admin registered successfully', admin_id: result.insertId });
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: 'Server error', error });
  }
};

// LOGIN ADMIN
exports.loginAdmin = (req, res) => {
  const { phone_number, password } = req.body;

  const sql = 'SELECT * FROM admin WHERE phone_number = ?';
  db.query(sql, [phone_number], async (err, results) => {
    if (err) return res.status(500).json({ message: 'Database error', error: err });

    if (results.length === 0) {
      return res.status(400).json({ success: false, message: 'Phone number not registered.' });
    }

    const admin = results[0];
    const isMatch = await bcrypt.compare(password, admin.password);

    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Incorrect password.' });
    }

    // Success
    res.json({ success: true, message: 'Login successful!', admin_id: admin.admin_id });
  });
};

// GET ALL ADMINS
exports.getAdmins = (req, res) => {
  const sql = 'SELECT admin_id, first_name, last_name, phone_number, city, created_at FROM admin';
  db.query(sql, (err, results) => {
    if (err) return res.status(500).json({ message: 'Database error', error: err });
    res.json(results);
  });
};

// GET ADMIN BY ID
exports.getAdminById = (req, res) => {
  const { id } = req.params;
  const sql = 'SELECT * FROM admin WHERE admin_id = ?';
  db.query(sql, [id], (err, results) => {
    if (err) return res.status(500).json({ message: 'Database error', error: err });
    if (results.length === 0) return res.status(404).json({ message: 'Admin not found' });
    res.json(results[0]);
  });
};

// UPDATE ADMIN
exports.updateAdmin = (req, res) => {
  const { id } = req.params;
  const { first_name, last_name, street, zone, barangay, city, phone_number } = req.body;

  const sql = `UPDATE admin SET first_name=?, last_name=?, street=?, zone=?, barangay=?, city=?, phone_number=? WHERE admin_id=?`;

  db.query(sql, [first_name, last_name, street, zone, barangay, city, phone_number, id], (err, result) => {
    if (err) return res.status(500).json({ message: 'Database error', error: err });
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Admin not found' });

    res.json({ message: 'Admin updated successfully' });
  });
};

// DELETE ADMIN
exports.deleteAdmin = (req, res) => {
  const { id } = req.params;
  const sql = 'DELETE FROM admin WHERE admin_id = ?';

  db.query(sql, [id], (err, result) => {
    if (err) return res.status(500).json({ message: 'Database error', error: err });
    if (result.affectedRows === 0) return res.status(404).json({ message: 'Admin not found' });

    res.json({ message: 'Admin deleted successfully' });
  });
};
