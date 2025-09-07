const bcrypt = require('bcryptjs');

const db = require('../config/db'); // Use the shared db connection


exports.registerCustomer = async (req, res) => {
  const { first_name, last_name, username, street, zone, barangay, city, phone_number, password } = req.body;

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    const sql = `INSERT INTO customer 
      (first_name, last_name, username, street, zone, barangay, city, phone_number, password_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    db.query(sql, [first_name, last_name, username, street, zone, barangay, city, phone_number, hashedPassword], (err, result) => {
      if (err) {
        console.log(err);
        return res.status(500).json({ message: 'Database error', error: err });
      }

      res.status(201).json({ message: 'Customer registered successfully', customer_id: result.insertId });
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: 'Server error', error });
  }
};

exports.loginCustomer = (req, res) => {
  const { phone_number, password } = req.body;

  const sql = 'SELECT * FROM customer WHERE phone_number = ?';
  db.query(sql, [phone_number], async (err, results) => {
    if (err) return res.status(500).json({ message: 'Database error', error: err });

    if (results.length === 0) {
      return res.status(400).json({ success: false, message: 'Phone number not registered.' });
    }

    const customer = results[0];
    const isMatch = await bcrypt.compare(password, customer.password_hash);

    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Incorrect password.' });
    }

    // Login successful – return first_name too
    res.json({ 
      success: true, 
      message: 'Login successful!', 
      customer: { 
        customer_id: customer.customer_id,
        first_name: customer.first_name,
        last_name: customer.last_name,
        username: customer.username,
        phone_number: customer.phone_number
      }
    });
  });
};

exports.getCustomer = (req, res) => {
  const { customerId } = req.params;

  const sql = 'SELECT customer_id, first_name, last_name, username, phone_number FROM customer WHERE customer_id = ?';
  db.query(sql, [customerId], (err, results) => {
    if (err) {
      console.error('Database error:', err);
      return res.status(500).json({ message: 'Database error', error: err });
    }

    if (results.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    const customer = results[0];
    res.json({ 
      customer_id: customer.customer_id,
      name: `${customer.first_name} ${customer.last_name}`,
      first_name: customer.first_name,
      last_name: customer.last_name,
      username: customer.username,
      phone_number: customer.phone_number
    });
  });
};
