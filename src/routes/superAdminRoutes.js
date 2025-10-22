const express = require('express');
const router = express.Router();
const superAdminController = require('../controllers/superAdminController');

// Register
router.post('/register', superAdminController.registerSuperAdmin);

// Login
router.post('/login', superAdminController.loginSuperAdmin);

// Dashboard stats
router.get('/dashboard/stats', superAdminController.getDashboardStats);

module.exports = router;
