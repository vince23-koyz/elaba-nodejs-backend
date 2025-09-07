// src/routes/customerRoutes.js
const express = require('express');
const router = express.Router();
const customerController = require('../controllers/customerController');

router.post('/', customerController.registerCustomer);
router.post('/login', customerController.loginCustomer);
router.get('/:customerId', customerController.getCustomer);

module.exports = router;