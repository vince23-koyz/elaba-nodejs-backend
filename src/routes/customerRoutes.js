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
// Profile picture upload with explicit error handling so Cloudinary/multer errors return clear JSON
router.post('/:customerId/profile-picture', (req, res, next) => {
	console.log('➡️  Incoming profile picture upload for customer:', req.params.customerId);
	console.log('Headers:', {
		'content-type': req.headers['content-type'],
		'user-agent': req.headers['user-agent'],
		'content-length': req.headers['content-length']
	});
	upload.single('profilePicture')(req, res, function(err) {
		if (err) {
			// Multer or Cloudinary error
				console.error('❌ Upload middleware error:', {
					name: err.name,
					message: err.message,
					stack: err.stack,
				});
				const status = err.name === 'MulterError' ? 400 : 500;
				const safeMessage = err && (err.message || String(err));
				return res.status(status).json({ success: false, message: safeMessage || 'Upload failed' });
		}
		return customerController.updateProfilePicture(req, res, next);
	});
});


module.exports = router;