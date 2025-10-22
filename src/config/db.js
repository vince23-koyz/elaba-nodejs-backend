// db.js
const mysql = require('mysql2');
require('dotenv').config();

// Create a MySQL connection pool
// This allows multiple connections to be handled efficiently
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'elaba_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

//Convert to promise-based pool
const db = pool.promise();

// Test the connection
(async () => {
  try {
    const connection = await db.getConnection();
    console.log('✅ Connected to MySQL database');
    connection.release();
  } catch (err) {
    console.error('❌ MySQL connection error:', err.message);
  }
})();

module.exports = db;
