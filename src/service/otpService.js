// eLaba-backend/src/service/otpService.js
const db = require('../config/db');
const crypto = require('crypto');
const axios = require('axios');

const OTP_EXPIRATION_MINUTES = 5;
const OTP_SMS_ENABLED = process.env.OTP_SMS_ENABLED === 'true';
const DISPLAY_EXPIRATION = '5 minutes';

const SEMAPHORE_API_URL = 'https://api.semaphore.co/api/v4/messages';
const SEMAPHORE_API_KEY = process.env.SEMAPHORE_API_KEY;
const SEMAPHORE_SENDER_NAME = process.env.SEMAPHORE_SENDER_NAME;

const normalizeSemaphoreNumber = (phoneNumber) => {
  const digits = String(phoneNumber || '').replace(/\D/g, '');

  if (digits.startsWith('09') && digits.length === 11) {
    return `63${digits.slice(1)}`;
  }

  if (digits.startsWith('63') && digits.length === 12) {
    return digits;
  }

  if (digits.startsWith('9') && digits.length === 10) {
    return `63${digits}`;
  }

  return digits;
};

// 🔹 Helper for sending SMS
const sendSms = async (phoneNumber, message) => {
  if (!SEMAPHORE_API_KEY || !SEMAPHORE_SENDER_NAME) {
    throw new Error('Semaphore SMS configuration is missing');
  }

  const requestBody = new URLSearchParams({
    apikey: SEMAPHORE_API_KEY,
    number: normalizeSemaphoreNumber(phoneNumber),
    message,
    sendername: SEMAPHORE_SENDER_NAME,
  });

  await axios.post(SEMAPHORE_API_URL, requestBody.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
};

const OtpService = {
  // 📨 Send OTP
  sendOtp: async (phoneNumber) => {
    const otpCode = crypto.randomInt(100000, 999999).toString();
    const expiresAt = new Date(
      Date.now() + OTP_EXPIRATION_MINUTES * 60 * 1000
    );

    // 🧹 Delete existing OTP for same number (fresh start)
    await db.query(
      'DELETE FROM otp_verification WHERE phone_number = ?',
      [phoneNumber]
    );

    // 💾 Save new OTP
    await db.query(
      'INSERT INTO otp_verification (phone_number, otp_code, expires_at) VALUES (?, ?, ?)',
      [phoneNumber, otpCode, expiresAt]
    );

    // 📨 Prepare SMS
    const message =
      `Your eLaba verification code is: ${otpCode}. ` +
      `This code expires in ${DISPLAY_EXPIRATION}. ` +
      `If you did not request this, please ignore this message.`;

    // 📨 Send SMS only when enabled
    if (OTP_SMS_ENABLED) {
      await sendSms(phoneNumber, message);
      console.log(
        `📲 OTP SMS sent - OTP for ${phoneNumber}: ${otpCode}`
      );
    } else {
      console.log(
        `🔕 OTP SMS disabled - OTP for ${phoneNumber}: ${otpCode}`
      );
    }

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
      return {
        success: false,
        message: 'Invalid or expired OTP',
      };
    }

    const otpRecord = rows[0];
    const now = new Date();

    if (new Date(otpRecord.expires_at) < now) {
      return {
        success: false,
        message: 'OTP expired',
      };
    }

    // ✅ OTP valid → delete after verification
    await db.query(
      'DELETE FROM otp_verification WHERE phone_number = ?',
      [phoneNumber]
    );

    return {
      success: true,
      message: 'OTP verified successfully',
    };
  },
};

module.exports = OtpService;