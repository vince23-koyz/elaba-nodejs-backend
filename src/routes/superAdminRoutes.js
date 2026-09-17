const express = require('express');
const router = express.Router();
const superAdminController = require('../controllers/superAdminController');

// Login
router.post('/login', superAdminController.loginSuperAdmin);
router.post('/:id/change-password', superAdminController.changePassword);

// Dashboard stats
router.get('/dashboard/stats', superAdminController.getDashboardStats);
router.get('/revenue-analytics', superAdminController.getRevenueAnalytics);

module.exports = router;
