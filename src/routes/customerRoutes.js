// src/routes/customerRoutes.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const router = express.Router();
const customerController = require('../controllers/customerController');
const upload = require('../config/multer');

router.post('/', customerController.registerCustomer);
router.post('/check-phone', customerController.checkPhone);  // POST /api/customers/check-phone (secure phone verification)
router.post('/login', customerController.loginCustomer);
router.get('/', customerController.getAllCustomers); // GET all customers (for dashboard)
router.get('/:customerId', customerController.getCustomer);
router.put('/:customerId', customerController.updateCustomer);
router.post('/:customerId/profile-picture', upload.single('profilePicture'), customerController.updateProfilePicture);


module.exports = router;