// src/routes/adminRoutes.js
const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');

// ADMIN ROUTES
router.post('/register', adminController.registerAdmin);  // POST /api/admin/register
router.post('/login', adminController.loginAdmin);        // POST /api/admin/login
router.get('/', adminController.getAdmins);              // GET /api/admin
router.get('/:id', adminController.getAdminById);        // GET /api/admin/:id
router.put('/:id', adminController.updateAdmin);         // PUT /api/admin/:id
router.delete('/:id', adminController.deleteAdmin);      // DELETE /api/admin/:id

module.exports = router;
