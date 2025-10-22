const express = require('express');
const router = express.Router();
const OtpController = require('../controllers/otpController');

// Send OTP
router.post('/send', OtpController.sendOtp);

// Verify OTP
router.post('/verify', OtpController.verifyOtp);

// Reset password
router.post('/reset-password', OtpController.resetPassword);

module.exports = router;
