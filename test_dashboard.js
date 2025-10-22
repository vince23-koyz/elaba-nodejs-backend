// Test script to verify dashboard stats endpoint
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const superAdminRoutes = require('./src/routes/superAdminRoutes');
const shopRoutes = require('./src/routes/shopRoutes');
const customerRoutes = require('./src/routes/customerRoutes');

const app = express();
const PORT = 5000;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Routes
app.use('/api/superadmin', superAdminRoutes);
app.use('/api/shop', shopRoutes);
app.use('/api/customers', customerRoutes);

// Test route
app.get('/api/test', (req, res) => {
  res.json({ message: 'Backend is running!', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Test Server running on http://localhost:${PORT}`);
  console.log(`📊 Dashboard stats endpoint: http://localhost:${PORT}/api/superadmin/dashboard/stats`);
  console.log(`👥 Customers endpoint: http://localhost:${PORT}/api/customers`);
  console.log(`🏪 Shops endpoint: http://localhost:${PORT}/api/shop`);
  console.log(`✅ Test endpoint: http://localhost:${PORT}/api/test`);
});

module.exports = app;