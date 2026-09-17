const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const db = require('../config/db'); // Use the shared db connection
const { normalizePhoneNumber } = require('../utils/phoneUtils');

const failedLoginAttempts = new Map();
const FAILED_LOGIN_LIMIT = 5;
const FAILED_LOGIN_WINDOW_MS = 10 * 60 * 1000;

const cleanupExpiredFailedLoginRecords = () => {
  const now = Date.now();
  for (const [phoneKey, record] of failedLoginAttempts.entries()) {
    if (record.lockedUntil <= now) {
      failedLoginAttempts.delete(phoneKey);
    }
  }
};

exports.verifyOTP = async (req, res) => {
  const { phone_number, otp } = req.body;

  if (!phone_number || !otp) {
    return res.status(400).json({ success: false, message: 'Phone number and OTP are required' });
  }

  try {
    const cleanPhone = phone_number.replace(/\D/g, '');
    const phoneVariations = [phone_number.trim(), cleanPhone];

    if (cleanPhone.startsWith('63') && cleanPhone.length >= 12) {
      const withoutCountryCode = cleanPhone.substring(2);
      phoneVariations.push(withoutCountryCode, '0' + withoutCountryCode);
    }
    if (cleanPhone.startsWith('09') && cleanPhone.length >= 11) {
      phoneVariations.push('+63' + cleanPhone.substring(1), '63' + cleanPhone.substring(1), cleanPhone.substring(1));
    }
    if (cleanPhone.startsWith('9') && !cleanPhone.startsWith('09') && cleanPhone.length >= 10) {
      phoneVariations.push('0' + cleanPhone, '+63' + cleanPhone, '63' + cleanPhone);
    }

    let customer = null;
    let matchedPhone = null;
    for (const phoneVar of [...new Set(phoneVariations)]) {
      const [results] = await db.query(
        'SELECT customer_id, phone_number FROM customer WHERE phone_number = ? LIMIT 1',
        [phoneVar]
      );
      if (results.length > 0) {
        customer = results[0];
        matchedPhone = results[0].phone_number;
        break;
      }
    }

    if (!customer) {
      return res.status(404).json({ success: false, message: 'Customer account not found.' });
    }
    if (otp.length !== 6 || !/^\d+$/.test(otp)) {
      return res.status(400).json({ success: false, message: 'OTP must be exactly 6 digits' });
    }

    const [otpRows] = await db.query(
      'SELECT otp_code, expires_at FROM otp_verification WHERE phone_number = ? AND otp_code = ? ORDER BY created_at DESC LIMIT 1',
      [matchedPhone, otp]
    );
    if (otpRows.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid OTP. Please request a new code.' });
    }
    if (new Date(otpRows[0].expires_at) < new Date()) {
      await db.query('DELETE FROM otp_verification WHERE phone_number = ?', [matchedPhone]);
      return res.status(400).json({ success: false, message: 'OTP expired. Please request a new code.' });
    }

    await db.query('DELETE FROM otp_verification WHERE phone_number = ?', [matchedPhone]);
    return res.json({ success: true, message: 'OTP verified successfully.' });
  } catch (err) {
    console.error('DB Error (customer verifyOTP):', err);
    return res.status(500).json({ success: false, message: 'Database error occurred while verifying OTP' });
  }
};

const getFailedLoginRecord = (normalizedPhone) => {
  cleanupExpiredFailedLoginRecords();

  const existing = failedLoginAttempts.get(normalizedPhone);
  if (!existing) {
    return null;
  }

  if (existing.lockedUntil <= Date.now()) {
    failedLoginAttempts.delete(normalizedPhone);
    return null;
  }

  return existing;
};

const incrementFailedLoginAttempt = (normalizedPhone) => {
  cleanupExpiredFailedLoginRecords();

  const existing = failedLoginAttempts.get(normalizedPhone);
  const now = Date.now();

  if (!existing) {
    const record = {
      failedAttempts: 1,
      lockedUntil: now + FAILED_LOGIN_WINDOW_MS,
    };
    failedLoginAttempts.set(normalizedPhone, record);
    return record;
  }

  if (existing.lockedUntil <= now) {
    const record = {
      failedAttempts: 1,
      lockedUntil: now + FAILED_LOGIN_WINDOW_MS,
    };
    failedLoginAttempts.set(normalizedPhone, record);
    return record;
  }

  const updated = {
    failedAttempts: existing.failedAttempts + 1,
    lockedUntil: existing.lockedUntil,
  };

  failedLoginAttempts.set(normalizedPhone, updated);
  return updated;
};

const resetFailedLoginAttempt = (normalizedPhone) => {
  failedLoginAttempts.delete(normalizedPhone);
};


// CHECK PHONE - Secure endpoint to check if phone number exists (returns only true/false)
exports.checkPhone = async (req, res) => {
  const { phone_number } = req.body;

  if (!phone_number) {
    return res.status(400).json({ 
      exists: false, 
      message: 'Phone number is required' 
    });
  }

  try {
    console.log(`🔍 Customer Phone Check - Input phone: "${phone_number}"`);
    
    // Clean the input phone number
    const cleanPhone = phone_number.replace(/\D/g, ''); // Remove non-digits
    
    // Generate comprehensive phone variations for flexible matching
    const phoneVariations = [
      phone_number.trim(),             // Original input as-is
      cleanPhone,                      // Just digits
    ];

    // Add variations based on common Philippine formats
    if (cleanPhone.startsWith('63') && cleanPhone.length >= 12) {
      // +63XXXXXXXXXX format
      const withoutCountryCode = cleanPhone.substring(2); // Remove 63
      phoneVariations.push(withoutCountryCode); 
      phoneVariations.push('0' + withoutCountryCode); // Add 0 prefix (09XXXXXXXXX)
    }

    if (cleanPhone.startsWith('09') && cleanPhone.length >= 11) {
      // 09XXXXXXXXX format
      phoneVariations.push('+63' + cleanPhone.substring(1)); // Convert to +639XXXXXXXXX
      phoneVariations.push('63' + cleanPhone.substring(1));  // Convert to 639XXXXXXXXX
      phoneVariations.push(cleanPhone.substring(1));         // Convert to 9XXXXXXXXX
    }
    
    if (cleanPhone.startsWith('9') && !cleanPhone.startsWith('09') && cleanPhone.length >= 10) {
      // 9XXXXXXXXX format
      phoneVariations.push('0' + cleanPhone);               // Convert to 09XXXXXXXXX
      phoneVariations.push('+63' + cleanPhone);             // Convert to +639XXXXXXXXX
      phoneVariations.push('63' + cleanPhone);              // Convert to 639XXXXXXXXX
    }

    // Remove duplicates and empty strings
    const uniqueVariations = [...new Set(phoneVariations.filter(p => p && p.length > 0))];
    console.log(`📱 Customer phone variations to check:`, uniqueVariations);

    let customerExists = false;
    
    // Try each phone variation
    for (const phoneVar of uniqueVariations) {
      const sql = 'SELECT customer_id FROM customer WHERE phone_number = ? LIMIT 1';
      const [results] = await db.query(sql, [phoneVar]);
      
      if (results.length > 0) {
        customerExists = true;
        console.log(`✅ Customer phone number exists with variation: "${phoneVar}"`);
        break;
      }
    }

    if (!customerExists) {
      console.log(`❌ Customer phone number not found in database`);
    }

    // Always return the same response format (just true/false) for security
    res.json({ 
      exists: customerExists 
    });

  } catch (err) {
    console.error("DB Error (customer checkPhone):", err);
    // Don't expose database errors to client for security
    res.status(500).json({ 
      exists: false 
    });
  }
};

// GET ALL CUSTOMERS (for superadmin dashboard)
exports.getAllCustomers = async (req, res) => {
  try {
    const sql = `SELECT customer_id, first_name, last_name, username, phone_number, 
                        street, zone, barangay, city, profile_picture, created_at
                 FROM customer 
                 ORDER BY created_at DESC`;
    const [results] = await db.query(sql);
    
    res.json(results);
  } catch (err) {
    console.error("DB Error (getAllCustomers):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

exports.registerCustomer = async (req, res) => {
  const { first_name, last_name, username, street, zone, barangay, city, phone_number, password } = req.body;

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    const sql = `INSERT INTO customer 
      (first_name, last_name, username, street, zone, barangay, city, phone_number, password_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    const [result] = await db.query(sql, [first_name, last_name, username, street, zone, barangay, city, phone_number, hashedPassword]);

    res.status(201).json({ message: 'Customer registered successfully', customer_id: result.insertId });
  } catch (err) {
    console.error("DB Error (registerCustomer):", err);
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ message: 'Phone number already registered' });
    }
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

exports.loginCustomer = async (req, res) => {
  const { phone_number, password } = req.body;

  try {
    const normalizedPhone = normalizePhoneNumber(phone_number);
    const failedRecord = getFailedLoginRecord(normalizedPhone);

    if (failedRecord && failedRecord.failedAttempts >= FAILED_LOGIN_LIMIT) {
      return res.status(429).json({
        success: false,
        code: 'TOO_MANY_ATTEMPTS',
        message: 'Too many unsuccessful login attempts. Please wait a few minutes before trying again.'
      });
    }

    const sql = 'SELECT * FROM customer WHERE phone_number = ?';
    const [results] = await db.query(sql, [phone_number]);

    if (results.length === 0) {
      incrementFailedLoginAttempt(normalizedPhone);
      return res.status(401).json({
        success: false,
        code: 'INVALID_CREDENTIALS',
        message: 'The phone number or password you entered is incorrect. Please check your credentials and try again.'
      });
    }

    const customer = results[0];
    const isMatch = await bcrypt.compare(password, customer.password_hash);

    if (!isMatch) {
      const updatedRecord = incrementFailedLoginAttempt(normalizedPhone);
      if (updatedRecord.failedAttempts >= FAILED_LOGIN_LIMIT) {
        return res.status(429).json({
          success: false,
          code: 'TOO_MANY_ATTEMPTS',
          message: 'Too many unsuccessful login attempts. Please wait a few minutes before trying again.'
        });
      }

      return res.status(401).json({
        success: false,
        code: 'INVALID_CREDENTIALS',
        message: 'The phone number or password you entered is incorrect. Please check your credentials and try again.'
      });
    }

    resetFailedLoginAttempt(normalizedPhone);

    // Login successful – return first_name too
    res.json({ 
      success: true, 
      message: 'Login successful!', 
      customer: { 
        customer_id: customer.customer_id,
        first_name: customer.first_name,
        last_name: customer.last_name,
        username: customer.username,
        phone_number: customer.phone_number
      }
    });
  } catch (err) {
    console.error("DB Error (loginCustomer):", err);
    res.status(500).json({ success: false, message: 'Database error', error: err.message });
  }
};

exports.getCustomer = async (req, res) => {
  const { customerId } = req.params;

  try {
    const sql = 'SELECT customer_id, first_name, last_name, username, phone_number, street, zone, barangay, city, profile_picture FROM customer WHERE customer_id = ?';
    const [results] = await db.query(sql, [customerId]);

    if (results.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }
    
    const customer = results[0];
    res.json({ 
      customer_id: customer.customer_id,
      name: `${customer.first_name} ${customer.last_name}`,
      first_name: customer.first_name,
      last_name: customer.last_name,
      username: customer.username,
      phone_number: customer.phone_number,
      street: customer.street,
      zone: customer.zone,
      barangay: customer.barangay,
      city: customer.city,
      profile_picture: customer.profile_picture
    });
  } catch (err) {
    console.error("DB Error (getCustomer):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

exports.updateCustomer = async (req, res) => {
  const { customerId } = req.params;
  const { first_name, last_name, username, street, zone, barangay, city, profile_picture, status } = req.body;

  try {
    // Check if customer exists
    const checkSql = 'SELECT customer_id FROM customer WHERE customer_id = ?';
    const [checkResults] = await db.query(checkSql, [customerId]);

    if (checkResults.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    // Update customer information
    let updateSql = `UPDATE customer 
      SET first_name = ?, last_name = ?, username = ?, street = ?, zone = ?, barangay = ?, city = ?`;
    let queryParams = [first_name, last_name, username, street, zone, barangay, city];

    // Add profile_picture to update if provided
    if (profile_picture !== undefined) {
      updateSql += `, profile_picture = ?`;
      queryParams.push(profile_picture);
    }

    // Add status to update if provided
    if (status !== undefined) {
      updateSql += `, status = ?`;
      queryParams.push(status);
    }

    updateSql += ` WHERE customer_id = ?`;
    queryParams.push(customerId);

    await db.query(updateSql, queryParams);

    res.json({ 
      success: true, 
      message: 'Customer profile updated successfully',
      customer_id: customerId
    });
  } catch (err) {
    console.error("DB Error (updateCustomer):", err);
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ message: 'Username already exists' });
    }
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

exports.updateProfilePicture = async (req, res) => {
  const { customerId } = req.params;

  try {
    if (!req.file) {
      return res.status(400).json({ 
        success: false,
        message: 'No profile picture uploaded' 
      });
    }

    // Build a public URL from Cloudinary or local storage
    let profileUrl = req.file.path;
    try {
      const isHttp = typeof profileUrl === 'string' && /^https?:\/\//.test(profileUrl);
      if (!isHttp) {
        const filename = req.file.filename || (profileUrl ? profileUrl.split(/[\\/]/).pop() : `profile_${Date.now()}.jpg`);
        const baseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
        profileUrl = `${baseUrl}/uploads/profile/${filename}`;
      }
    } catch (_) {
      // Fallback: keep whatever path we have
    }

    // Check if customer exists
    const checkSql = 'SELECT customer_id, profile_picture FROM customer WHERE customer_id = ?';
    const [checkResults] = await db.query(checkSql, [customerId]);

    if (checkResults.length === 0) {
      return res.status(404).json({ 
        success: false,
        message: 'Customer not found' 
      });
    }

    // Update customer profile picture in DB
    const updateSql = 'UPDATE customer SET profile_picture = ? WHERE customer_id = ?';
    await db.query(updateSql, [profileUrl, customerId]);

    res.json({ 
      success: true, 
      message: 'Profile picture updated successfully',
      profile_picture: profileUrl // return Cloudinary URL
    });
  } catch (err) {
    console.error("DB Error (updateProfilePicture):", err);
    res.status(500).json({ 
      success: false,
      message: 'Database error', 
      error: err.message 
    });
  }
};

exports.forgotPassword = async (req, res) => {
  const { phone_number } = req.body;

  if (!phone_number) {
    return res.status(400).json({
      success: false,
      message: 'Phone number is required'
    });
  }

  try {
    // Clean and generate phone variations (reuse logic from checkPhone)
    const cleanPhone = phone_number.replace(/\D/g, '');
    const phoneVariations = [
      phone_number.trim(),
      cleanPhone,
    ];

    if (cleanPhone.startsWith('63') && cleanPhone.length >= 12) {
      const withoutCountryCode = cleanPhone.substring(2);
      phoneVariations.push(withoutCountryCode);
      phoneVariations.push('0' + withoutCountryCode);
    }

    if (cleanPhone.startsWith('09') && cleanPhone.length >= 11) {
      phoneVariations.push('+63' + cleanPhone.substring(1));
      phoneVariations.push('63' + cleanPhone.substring(1));
      phoneVariations.push(cleanPhone.substring(1));
    }

    if (cleanPhone.startsWith('9') && !cleanPhone.startsWith('09') && cleanPhone.length >= 10) {
      phoneVariations.push('0' + cleanPhone);
      phoneVariations.push('+63' + cleanPhone);
      phoneVariations.push('63' + cleanPhone);
    }

    const uniqueVariations = [...new Set(phoneVariations.filter(p => p && p.length > 0))];

    let customer = null;
    let matchedPhone = null;
    for (const phoneVar of uniqueVariations) {
      const sql = 'SELECT customer_id, phone_number FROM customer WHERE phone_number = ? LIMIT 1';
      const [results] = await db.query(sql, [phoneVar]);
      if (results.length > 0) {
        customer = results[0];
        matchedPhone = results[0].phone_number;
        break;
      }
    }

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found'
      });
    }

    const otp = crypto.randomInt(100000, 1000000).toString();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    await db.query('DELETE FROM otp_verification WHERE phone_number = ?', [matchedPhone]);
    await db.query(
      'INSERT INTO otp_verification (phone_number, otp_code, expires_at) VALUES (?, ?, ?)',
      [matchedPhone, otp, expiresAt]
    );
    console.log(`🔐 Generated OTP: ${otp} for customer: ${customer.customer_id}`);

    res.json({
      success: true,
      message: 'OTP generated successfully',
      otp,
      customer_id: customer.customer_id
    });
  } catch (err) {
    console.error("DB Error (forgotPassword):", err);
    res.status(500).json({
      success: false,
      message: 'Database error',
      error: err.message
    });
  }
}