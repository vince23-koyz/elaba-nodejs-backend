// eLaba-backend/src/controllers/otpController.js
const OtpService = require('../service/otpService');
const db = require('../config/db');
const bcrypt = require('bcryptjs');

const buildPhoneVariations = (phoneNumber) => {
  const cleanPhone = (phoneNumber || '').replace(/\D/g, '');
  const variations = [
    phoneNumber?.trim(),
    cleanPhone,
  ].filter(Boolean);

  if (cleanPhone.startsWith('63') && cleanPhone.length >= 12) {
    const withoutCountryCode = cleanPhone.substring(2);
    variations.push(withoutCountryCode);
    variations.push('0' + withoutCountryCode);
  }

  if (cleanPhone.startsWith('09') && cleanPhone.length >= 11) {
    variations.push('+63' + cleanPhone.substring(1));
    variations.push('63' + cleanPhone.substring(1));
    variations.push(cleanPhone.substring(1));
  }

  if (cleanPhone.startsWith('9') && !cleanPhone.startsWith('09') && cleanPhone.length >= 10) {
    variations.push('0' + cleanPhone);
    variations.push('+63' + cleanPhone);
    variations.push('63' + cleanPhone);
  }

  return [...new Set(variations)];
};

const OtpController = {
  // 📨 Step 1: Send OTP (for Registration)
  sendOtp: async (req, res) => {
    try {
      const { phone_number } = req.body;
      if (!phone_number)
        return res.status(400).json({ message: 'Phone number is required' });

      // 🔍 Check if phone number is already registered (optional)
      const [existing] = await db.query(
        `SELECT phone_number FROM customer WHERE phone_number = ? 
         UNION 
         SELECT phone_number FROM admin WHERE phone_number = ?`,
        [phone_number, phone_number]
      );

      if (existing.length > 0)
        return res
          .status(400)
          .json({ message: 'Phone number already registered. Please log in.' });

      // 📨 Send OTP
      await OtpService.sendOtp(phone_number);
      res.status(200).json({ success: true, message: 'OTP sent successfully' });
    } catch (error) {
      console.error('❌ Send OTP Error:', error);
      res.status(500).json({ message: 'Failed to send OTP' });
    }
  },

  // ✅ Step 2: Verify OTP
  verifyOtp: async (req, res) => {
    try {
      const { phone_number, otp_code } = req.body;
      if (!phone_number || !otp_code)
        return res.status(400).json({ message: 'Phone number and OTP are required' });

      const result = await OtpService.verifyOtp(phone_number, otp_code);
      res.status(result.success ? 200 : 400).json(result);
    } catch (error) {
      console.error('❌ Verify OTP Error:', error);
      res.status(500).json({ message: 'OTP verification failed' });
    }
  },

  // 🔐 Step 3: Reset Password (for Forgot Password)
  resetPassword: async (req, res) => {
    try {
      const { phone_number, new_password } = req.body;
      if (!phone_number || !new_password)
        return res.status(400).json({ message: 'Phone number and new password required' });

      const phoneVariations = buildPhoneVariations(phone_number);
      const hashedPassword = await bcrypt.hash(new_password, 10);

      const customerPlaceholders = phoneVariations.map(() => '?').join(',');
      const [updateCustomer] = await db.query(
        `UPDATE customer SET password_hash = ? WHERE phone_number IN (${customerPlaceholders})`,
        [hashedPassword, ...phoneVariations]
      );

      const [updateAdmin] = await db.query(
        `UPDATE admin SET password = ? WHERE phone_number IN (${customerPlaceholders})`,
        [hashedPassword, ...phoneVariations]
      );

      if (updateCustomer.affectedRows === 0 && updateAdmin.affectedRows === 0)
        return res.status(404).json({ message: 'Phone number not found' });

      res.status(200).json({ success: true, message: 'Password reset successful' });
    } catch (error) {
      console.error('❌ Reset Password Error:', error);
      res.status(500).json({ message: 'Failed to reset password' });
    }
  },
};

module.exports = OtpController;
