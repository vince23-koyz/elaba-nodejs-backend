// src/routes/adminRoutes.js
const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');

// ADMIN ROUTES
router.post('/register', adminController.registerAdmin);  // POST /api/admin/register
router.post('/check-phone', adminController.checkPhone);  // POST /api/admin/check-phone (secure phone verification)
router.post('/login', adminController.loginAdmin);        // POST /api/admin/login
router.post('/:id/change-password', adminController.changePassword); // POST /api/admin/:id/change-password

// Password Recovery Routes
router.post('/forgot-password', adminController.forgotPassword);    // POST /api/admin/forgot-password
router.post('/verify-otp', adminController.verifyOTP);              // POST /api/admin/verify-otp
router.post('/reset-password', adminController.resetPassword);      // POST /api/admin/reset-password

router.get('/', adminController.getAdmins);              // GET /api/admin
router.get('/:id', adminController.getAdminById);        // GET /api/admin/:id
router.put('/:id', adminController.updateAdmin);         // PUT /api/admin/:id
router.delete('/:id', adminController.deleteAdmin);      // DELETE /api/admin/:id

// Dashboard Routes
router.get('/dashboard/stats', adminController.getDashboardStats);           // GET /api/admin/dashboard/stats
router.get('/dashboard/activities', adminController.getRecentActivities);    // GET /api/admin/dashboard/activities
router.get('/dashboard/system-health', adminController.getSystemHealth);     // GET /api/admin/dashboard/system-health

module.exports = router;
