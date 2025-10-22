// src/routes/customerRoutes.js
const express = require('express');
const multer = require('multer');
const path = require('path');
const router = express.Router();
const customerController = require('../controllers/customerController');

// Configure multer for profile picture uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/customer-profile/');
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'profile-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: function (req, file, cb) {
    // Accept only image files
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  }
});

router.post('/', customerController.registerCustomer);
router.post('/check-phone', customerController.checkPhone);  // POST /api/customers/check-phone (secure phone verification)
router.post('/login', customerController.loginCustomer);
router.get('/', customerController.getAllCustomers); // GET all customers (for dashboard)
router.get('/:customerId', customerController.getCustomer);
router.put('/:customerId', customerController.updateCustomer);
router.post('/:customerId/profile-picture', upload.single('profilePicture'), customerController.updateProfilePicture);


module.exports = router;