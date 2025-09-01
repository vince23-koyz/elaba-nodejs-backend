// db.js
const mysql = require('mysql2');
require('dotenv').config();

// Create a MySQL connection pool
// This allows multiple connections to be handled efficiently
const db = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'elaba_db',
  waitForConnections: true
});

// Test the connection
// This is a simple test to ensure the connection is working
// It will log an error if the connection fails
db.getConnection((err, connection) => {
  if (err) {
    console.error('❌ MySQL connection error:', err.message);
  } else {
    console.log('✅ Connected to MySQL database');
    connection.release(); 
  }
});

module.exports = db;
