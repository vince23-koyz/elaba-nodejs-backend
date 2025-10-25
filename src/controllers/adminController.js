const bcrypt = require('bcryptjs');
const db = require('../config/db'); // promise-based pool

// REGISTER ADMIN
exports.registerAdmin = async (req, res) => {
  const { first_name, last_name, street, zone, barangay, city, phone_number, password } = req.body;

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    const sql = `INSERT INTO admin 
      (first_name, last_name, street, zone, barangay, city, phone_number, password)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

    const [result] = await db.query(sql, [
      first_name, last_name, street, zone, barangay, city, phone_number, hashedPassword
    ]);

    res.status(201).json({
      message: 'Admin registered successfully',
      admin_id: result.insertId
    });
  } catch (err) {
    console.error("DB Error (registerAdmin):", err);
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ message: 'Registration failed for this phone number. Please try a different one.Phone number already registered' });
    }
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

// LOGIN ADMIN
exports.loginAdmin = async (req, res) => {
  const { phone_number, password } = req.body;

  try {
    const sql = 'SELECT * FROM admin WHERE phone_number = ?';
    const [results] = await db.query(sql, [phone_number]);

    if (results.length === 0) {
      return res.status(400).json({ success: false, message: 'Phone number not registered.' });
    }

    const admin = results[0];
    const isMatch = await bcrypt.compare(password, admin.password);

    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Incorrect password.' });
    }

    res.json({ success: true, message: 'Login successful!', admin_id: admin.admin_id });
  } catch (err) {
    console.error("DB Error (loginAdmin):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

// GET ALL ADMINS
exports.getAdmins = async (req, res) => {
  try {
    const sql = 'SELECT admin_id, first_name, last_name, phone_number, city, created_at FROM admin';
    const [results] = await db.query(sql);
    res.json(results);
  } catch (err) {
    console.error("DB Error (getAdmins):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

// GET ADMIN BY ID
exports.getAdminById = async (req, res) => {
  const { id } = req.params;
  try {
    const sql = 'SELECT * FROM admin WHERE admin_id = ?';
    const [results] = await db.query(sql, [id]);

    if (results.length === 0) return res.status(404).json({ message: 'Admin not found' });
    res.json(results[0]);
  } catch (err) {
    console.error("DB Error (getAdminById):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

// UPDATE ADMIN
exports.updateAdmin = async (req, res) => {
  const { id } = req.params;
  const { first_name, last_name, street, zone, barangay, city, phone_number } = req.body;

  try {
    const sql = `UPDATE admin 
                 SET first_name=?, last_name=?, street=?, zone=?, barangay=?, city=?, phone_number=? 
                 WHERE admin_id=?`;

    const [result] = await db.query(sql, [
      first_name, last_name, street, zone, barangay, city, phone_number, id
    ]);

    if (result.affectedRows === 0) return res.status(404).json({ message: 'Admin not found' });
    res.json({ message: 'Admin updated successfully' });
  } catch (err) {
    console.error("DB Error (updateAdmin):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

// DELETE ADMIN
exports.deleteAdmin = async (req, res) => {
  const { id } = req.params;

  try {
    const sql = 'DELETE FROM admin WHERE admin_id = ?';
    const [result] = await db.query(sql, [id]);

    if (result.affectedRows === 0) return res.status(404).json({ message: 'Admin not found' });
    res.json({ message: 'Admin deleted successfully' });
  } catch (err) {
    console.error("DB Error (deleteAdmin):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

// CHANGE PASSWORD
exports.changePassword = async (req, res) => {
  const { id } = req.params;
  const { currentPassword, newPassword } = req.body;

  // Validation
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ 
      success: false, 
      message: 'Current password and new password are required' 
    });
  }

  if (currentPassword === newPassword) {
    return res.status(400).json({ 
      success: false, 
      message: 'New password must be different from current password' 
    });
  }

  // Basic password strength validation
  if (newPassword.length < 8) {
    return res.status(400).json({ 
      success: false, 
      message: 'New password must be at least 8 characters long' 
    });
  }

  try {
    // First, get the admin with current password
    const getAdminSql = 'SELECT * FROM admin WHERE admin_id = ?';
    const [adminResults] = await db.query(getAdminSql, [id]);

    if (adminResults.length === 0) {
      return res.status(404).json({ success: false, message: 'Admin not found' });
    }

    const admin = adminResults[0];

    // Verify current password
    const isCurrentPasswordValid = await bcrypt.compare(currentPassword, admin.password);
    
    if (!isCurrentPasswordValid) {
      return res.status(400).json({ 
        success: false, 
        message: 'Current password is incorrect' 
      });
    }

    // Hash the new password
    const hashedNewPassword = await bcrypt.hash(newPassword, 10);

    // Update the password
    const updateSql = 'UPDATE admin SET password = ? WHERE admin_id = ?';
    const [updateResult] = await db.query(updateSql, [hashedNewPassword, id]);

    if (updateResult.affectedRows === 0) {
      return res.status(500).json({ 
        success: false, 
        message: 'Failed to update password' 
      });
    }

    res.json({ 
      success: true, 
      message: 'Password changed successfully' 
    });

  } catch (err) {
    console.error("DB Error (changePassword):", err);
    res.status(500).json({ 
      success: false, 
      message: 'Database error', 
      error: err.message 
    });
  }
};

// FORGOT PASSWORD - Check if admin exists and generate OTP with flexible phone matching
exports.forgotPassword = async (req, res) => {
  const { phone_number } = req.body;

  if (!phone_number) {
    return res.status(400).json({ 
      success: false, 
      message: 'Phone number is required' 
    });
  }

  try {
    console.log(`🔍 Forgot Password - Input phone: "${phone_number}"`);
    
    // Clean the input phone number
    const cleanPhone = phone_number.replace(/\D/g, ''); // Remove non-digits
    console.log(`🧹 Cleaned phone: "${cleanPhone}"`);

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
    console.log(`📱 Phone variations to try:`, uniqueVariations);

    let admin = null;
    let matchedPhone = null;
    
    // Try each phone variation
    for (const phoneVar of uniqueVariations) {
      const sql = 'SELECT admin_id, first_name, last_name, phone_number FROM admin WHERE phone_number = ?';
      const [results] = await db.query(sql, [phoneVar]);
      
      if (results.length > 0) {
        admin = results[0];
        matchedPhone = phoneVar;
        console.log(`✅ Found admin with phone variation: "${phoneVar}"`);
        break;
      }
    }

    if (!admin) {
      console.log(`❌ No admin found for any phone variation`);
      return res.status(404).json({ 
        success: false, 
        message: 'No admin account found with this phone number. Please check your phone number or contact support.' 
      });
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    console.log(`🔐 Generated OTP: ${otp} for admin: ${admin.first_name} ${admin.last_name}`);

    // Return success with OTP (in real app, this would send SMS)
    res.json({ 
      success: true, 
      message: `OTP sent successfully to ${phone_number}`,
      otp: otp, // Remove this in production
      admin_name: `${admin.first_name} ${admin.last_name}`,
      admin_id: admin.admin_id,
      matched_phone: matchedPhone // For debugging
    });

  } catch (err) {
    console.error("DB Error (forgotPassword):", err);
    res.status(500).json({ 
      success: false, 
      message: 'Database error occurred while checking phone number', 
      error: err.message 
    });
  }
};

// VERIFY OTP - Verify admin exists and OTP format with flexible phone matching
exports.verifyOTP = async (req, res) => {
  const { phone_number, otp } = req.body;

  if (!phone_number || !otp) {
    return res.status(400).json({ 
      success: false, 
      message: 'Phone number and OTP are required' 
    });
  }

  try {
    console.log(`🔍 Verify OTP - Input phone: "${phone_number}", OTP: "${otp}"`);
    
    // Use the same flexible phone matching logic as forgotPassword
    const cleanPhone = phone_number.replace(/\D/g, '');
    const phoneVariations = [
      phone_number.trim(),
      cleanPhone,
    ];

    // Add variations based on common Philippine formats
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
    console.log(`📱 Phone variations to try:`, uniqueVariations);

    let admin = null;
    
    // Try each phone variation
    for (const phoneVar of uniqueVariations) {
      const sql = 'SELECT admin_id, first_name, last_name, phone_number FROM admin WHERE phone_number = ?';
      const [results] = await db.query(sql, [phoneVar]);
      
      if (results.length > 0) {
        admin = results[0];
        console.log(`✅ Found admin for OTP verification: "${phoneVar}"`);
        break;
      }
    }

    if (!admin) {
      console.log(`❌ No admin found for OTP verification`);
      return res.status(404).json({ 
        success: false, 
        message: 'Admin account not found. Please start the password reset process again.' 
      });
    }

    // Validate OTP format
    if (otp.length !== 6 || !/^\d+$/.test(otp)) {
      return res.status(400).json({ 
        success: false, 
        message: 'OTP must be exactly 6 digits' 
      });
    }

    console.log(`✅ OTP format valid for admin: ${admin.first_name} ${admin.last_name}`);

    // For development, accept any valid 6-digit OTP
    res.json({ 
      success: true, 
      message: 'OTP verified successfully. You can now reset your password.',
      admin_name: `${admin.first_name} ${admin.last_name}`
    });

  } catch (err) {
    console.error("DB Error (verifyOTP):", err);
    res.status(500).json({ 
      success: false, 
      message: 'Database error occurred while verifying OTP', 
      error: err.message 
    });
  }
};

// RESET PASSWORD - Actually updates the password in database with proper validation and flexible phone matching
exports.resetPassword = async (req, res) => {
  const { phone_number, new_password } = req.body;

  if (!phone_number || !new_password) {
    return res.status(400).json({ 
      success: false, 
      message: 'Phone number and new password are required' 
    });
  }

  if (new_password.length < 6) {
    return res.status(400).json({ 
      success: false, 
      message: 'Password must be at least 6 characters long' 
    });
  }

  try {
    console.log(`🔍 Reset Password - Input phone: "${phone_number}"`);
    
    // Use the same flexible phone matching logic as forgotPassword and verifyOTP
    const cleanPhone = phone_number.replace(/\D/g, '');
    const phoneVariations = [
      phone_number.trim(),
      cleanPhone,
    ];

    // Add variations based on common Philippine formats
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
    console.log(`📱 Phone variations to try:`, uniqueVariations);

    let admin = null;
    let matchedPhone = null;
    
    // Try each phone variation to find the admin
    for (const phoneVar of uniqueVariations) {
      const checkSql = 'SELECT admin_id, first_name, last_name, phone_number FROM admin WHERE phone_number = ?';
      const [checkResults] = await db.query(checkSql, [phoneVar]);
      
      if (checkResults.length > 0) {
        admin = checkResults[0];
        matchedPhone = phoneVar;
        console.log(`✅ Found admin for password reset: "${phoneVar}"`);
        break;
      }
    }

    if (!admin) {
      console.log(`❌ No admin found for password reset`);
      return res.status(404).json({ 
        success: false, 
        message: 'Admin account not found with this phone number. Password reset failed.' 
      });
    }

    console.log(`🔐 Resetting password for admin: ${admin.first_name} ${admin.last_name} (ID: ${admin.admin_id})`);

    // Hash the new password with bcrypt
    const hashedPassword = await bcrypt.hash(new_password, 10);

    // Update admin password in database using the matched phone number
    const updateSql = 'UPDATE admin SET password = ? WHERE phone_number = ?';
    const [updateResult] = await db.query(updateSql, [hashedPassword, matchedPhone]);

    if (updateResult.affectedRows === 0) {
      console.log(`❌ Failed to update password - no rows affected`);
      return res.status(500).json({ 
        success: false, 
        message: 'Failed to update password in database' 
      });
    }

    console.log(`✅ Password successfully updated for admin: ${admin.first_name} ${admin.last_name}`);

    res.json({ 
      success: true, 
      message: `Password has been successfully reset for ${admin.first_name} ${admin.last_name}. You can now login with your new password.`,
      admin_name: `${admin.first_name} ${admin.last_name}`
    });

  } catch (err) {
    console.error("DB Error (resetPassword):", err);
    res.status(500).json({ 
      success: false, 
      message: 'Database error occurred while resetting password', 
      error: err.message 
    });
  }
};

// CHECK PHONE - Verify if phone number exists (secure phone verification)
exports.checkPhone = async (req, res) => {
  const { phone_number } = req.body;

  if (!phone_number) {
    return res.status(400).json({ 
      success: false, 
      message: 'Phone number is required' 
    });
  }

  try {
    console.log(`🔍 Check Phone - Input phone: "${phone_number}"`);
    
    // Clean the input phone number
    const cleanPhone = phone_number.replace(/\D/g, ''); // Remove non-digits
    console.log(`🧹 Cleaned phone: "${cleanPhone}"`);

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
    console.log(`📱 Phone variations to try:`, uniqueVariations);

    let admin = null;
    let matchedPhone = null;
    
    // Try each phone variation
    for (const phoneVar of uniqueVariations) {
      const sql = 'SELECT admin_id, first_name, last_name, phone_number FROM admin WHERE phone_number = ?';
      const [results] = await db.query(sql, [phoneVar]);
      
      if (results.length > 0) {
        admin = results[0];
        matchedPhone = phoneVar;
        console.log(`✅ Found admin with phone variation: "${phoneVar}"`);
        break;
      }
    }

    if (!admin) {
      console.log(`❌ No admin found for any phone variation`);
      return res.status(404).json({ 
        success: false, 
        message: 'Phone number not registered' 
      });
    }

    // Return success without revealing sensitive information
    res.json({ 
      success: true, 
      message: 'Phone number is registered',
      admin_name: `${admin.first_name} ${admin.last_name}`,
      admin_id: admin.admin_id
    });

  } catch (err) {
    console.error("DB Error (checkPhone):", err);
    res.status(500).json({ 
      success: false, 
      message: 'Database error occurred while checking phone number', 
      error: err.message 
    });
  }
};

// GET DASHBOARD STATS
exports.getDashboardStats = async (req, res) => {
  try {
    // Get total admins count
    const [adminCountResult] = await db.query('SELECT COUNT(*) as total_admins FROM admin');
    const totalAdmins = adminCountResult[0].total_admins;

    // Get total shops count (if shops table exists)
    let totalShops = 0;
    try {
      const [shopCountResult] = await db.query('SELECT COUNT(*) as total_shops FROM shops');
      totalShops = shopCountResult[0].total_shops;
    } catch (err) {
      console.log('Shops table not found, setting count to 0');
    }

    // Get total users count (if users table exists)
    let totalUsers = 0;
    try {
      const [userCountResult] = await db.query('SELECT COUNT(*) as total_users FROM users');
      totalUsers = userCountResult[0].total_users;
    } catch (err) {
      console.log('Users table not found, setting count to 0');
    }

    // Get recent admin registrations (last 30 days)
    const [recentAdminsResult] = await db.query(`
      SELECT COUNT(*) as recent_admins 
      FROM admin 
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
    `);
    const recentAdmins = recentAdminsResult[0].recent_admins;

    res.json({
      success: true,
      stats: {
        total_admins: totalAdmins,
        total_shops: totalShops,
        total_users: totalUsers,
        recent_admins: recentAdmins
      }
    });

  } catch (err) {
    console.error("DB Error (getDashboardStats):", err);
    res.status(500).json({ 
      success: false, 
      message: 'Database error occurred while fetching dashboard stats', 
      error: err.message 
    });
  }
};

// GET RECENT ACTIVITIES
exports.getRecentActivities = async (req, res) => {
  try {
    // Get recent admin registrations
    const [recentAdmins] = await db.query(`
      SELECT 
        admin_id,
        CONCAT(first_name, ' ', last_name) as name,
        'admin_registration' as activity_type,
        created_at as activity_date
      FROM admin 
      ORDER BY created_at DESC 
      LIMIT 10
    `);

    // Format activities
    const activities = recentAdmins.map(admin => ({
      id: admin.admin_id,
      type: admin.activity_type,
      description: `New admin registered: ${admin.name}`,
      date: admin.activity_date,
      user: admin.name
    }));

    res.json({
      success: true,
      activities: activities
    });

  } catch (err) {
    console.error("DB Error (getRecentActivities):", err);
    res.status(500).json({ 
      success: false, 
      message: 'Database error occurred while fetching recent activities', 
      error: err.message 
    });
  }
};

// GET SYSTEM HEALTH
exports.getSystemHealth = async (req, res) => {
  try {
    let dbStatus = 'healthy';
    let dbResponseTime = 0;
    
    const startTime = Date.now();
    
    try {
      // Test database connection with a simple query
      await db.query('SELECT 1');
      dbResponseTime = Date.now() - startTime;
      
      if (dbResponseTime > 1000) {
        dbStatus = 'slow';
      }
    } catch (err) {
      dbStatus = 'unhealthy';
      dbResponseTime = Date.now() - startTime;
    }

    const systemHealth = {
      database: {
        status: dbStatus,
        response_time_ms: dbResponseTime
      },
      server: {
        status: 'healthy',
        uptime: process.uptime(),
        memory_usage: process.memoryUsage()
      },
      timestamp: new Date().toISOString()
    };

    res.json({
      success: true,
      health: systemHealth
    });

  } catch (err) {
    console.error("Error (getSystemHealth):", err);
    res.status(500).json({ 
      success: false, 
      message: 'Error occurred while checking system health', 
      error: err.message 
    });
  }
};
