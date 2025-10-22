// eLaba-backend/src/service/otpService.js
const db = require('../config/db');
const crypto = require('crypto');
const axios = require('axios');

const OTP_EXPIRATION_MINUTES = process.env.NODE_ENV === 'development' ? 0.5 : 5;
const DISPLAY_EXPIRATION_MINUTES = 5;
const SEMAPHORE_API_URL = 'https://api.semaphore.co/api/v4/messages';
const SEMAPHORE_API_KEY = process.env.SEMAPHORE_API_KEY;
const SEMAPHORE_SENDER_NAME = process.env.SEMAPHORE_SENDER_NAME;

// 🔹 Helper for sending SMS
const sendSms = async (phoneNumber, message) => {
  console.log(`📱 Sending SMS to ${phoneNumber}: ${message}`);

  await axios.post(SEMAPHORE_API_URL, {
    apikey: SEMAPHORE_API_KEY,
    number: phoneNumber,
    message: message,
    sendername: SEMAPHORE_SENDER_NAME,
  });
};

const OtpService = {
  // 📨 Send OTP
  sendOtp: async (phoneNumber) => {
    const otpCode = crypto.randomInt(100000, 999999).toString();
    const expiresAt = new Date(Date.now() + OTP_EXPIRATION_MINUTES * 60 * 1000);

    // 🧹 Delete existing OTP for same number (fresh start)
    await db.query('DELETE FROM otp_verification WHERE phone_number = ?', [phoneNumber]);

    // 💾 Save new OTP
    await db.query(
      'INSERT INTO otp_verification (phone_number, otp_code, expires_at) VALUES (?, ?, ?)',
      [phoneNumber, otpCode, expiresAt]
    );

    // 📨 Send SMS
    const message = `Your eLaba verification code is: ${otpCode}. ` +
                    `This code expires in ${DISPLAY_EXPIRATION_MINUTES} minutes. ` +
                    `If you did not request this, please ignore this message.`;
    await sendSms(phoneNumber, message);
    
    return {
      success: true,
      message: 'OTP sent successfully',
      expiresAt,
    };
  },

  // ✅ Verify OTP
  verifyOtp: async (phoneNumber, otpCode) => {
    // 🔍 Check for valid OTP
    const [rows] = await db.query(
      'SELECT * FROM otp_verification WHERE phone_number = ? AND otp_code = ? ORDER BY created_at DESC LIMIT 1',
      [phoneNumber, otpCode]
    );

    if (rows.length === 0) {
      return { success: false, message: 'Invalid or expired OTP' };
    }
    
    const otpRecord = rows[0];
    const now = new Date();

    if (new Date(otpRecord.expires_at) < now) {
      return { success: false, message: 'OTP expired' };
    }

    // ✅ OTP valid → delete after verification
    await db.query('DELETE FROM otp_verification WHERE phone_number = ?', [phoneNumber]);

    return { success: true, message: 'OTP verified successfully' };
  },
};

module.exports = OtpService;
