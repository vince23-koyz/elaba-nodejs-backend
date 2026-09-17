const bcrypt = require('bcryptjs');
const db = require('../config/db');

// ✅ Register Super Admin
exports.registerSuperAdmin = async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password)
    return res.status(400).json({ message: "All fields are required." });

  try {
    // Check if email already exists
    const [existing] = await db.query("SELECT * FROM super_admin WHERE email = ?", [email]);
    if (existing.length > 0)
      return res.status(400).json({ message: "Email already exists." });

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
  
    const sql = "INSERT INTO super_admin (username, email, password) VALUES (?, ?, ?)";
    const [result] = await db.query(sql, [username, email, hashedPassword]);

    res.status(201).json({
      message: "Super Admin registered successfully!",
      super_admin_id: result.insertId,
    });
  } catch (err) {
    console.error("DB Error (registerSuperAdmin):", err);
    res.status(500).json({ message: "Database error", error: err.message });
  }
};

// ✅ Login Super Admin
exports.loginSuperAdmin = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password)
    return res.status(400).json({ success: false, message: "Email and password required." });

  try {
    const sql = "SELECT * FROM super_admin WHERE email = ?";
    const [rows] = await db.query(sql, [email]);

    if (rows.length === 0)
      return res.status(400).json({ success: false, message: "Email not registered." });

    const superAdmin = rows[0];
    const isMatch = await bcrypt.compare(password, superAdmin.password);

    if (!isMatch)
      return res.status(400).json({ success: false, message: "Incorrect password." });

    // ✅ Login success
    res.json({
      success: true,
      message: "Login successful!",
      super_admin: {
        id: superAdmin.super_admin_id,
        username: superAdmin.username,
        email: superAdmin.email,
      },
    });
  } catch (err) {
    console.error("DB Error (loginSuperAdmin):", err);
    res.status(500).json({ message: "Database error", error: err.message });
  }
};

// Change Super Admin Password
exports.changePassword = async (req, res) => {
  const { id } = req.params;
  const { currentPassword, newPassword } = req.body;

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

  if (newPassword.length < 8) {
    return res.status(400).json({
      success: false,
      message: 'New password must be at least 8 characters long'
    });
  }

  try {
    const [rows] = await db.query(
      'SELECT password FROM super_admin WHERE super_admin_id = ?',
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Super Admin not found' });
    }

    const isCurrentPasswordValid = await bcrypt.compare(currentPassword, rows[0].password);
    if (!isCurrentPasswordValid) {
      return res.status(400).json({ success: false, message: 'Current password is incorrect' });
    }

    const hashedNewPassword = await bcrypt.hash(newPassword, 10);
    const [result] = await db.query(
      'UPDATE super_admin SET password = ? WHERE super_admin_id = ?',
      [hashedNewPassword, id]
    );

    if (result.affectedRows === 0) {
      return res.status(500).json({ success: false, message: 'Failed to update password' });
    }

    return res.json({ success: true, message: 'Password changed successfully' });
  } catch (err) {
    console.error('DB Error (changeSuperAdminPassword):', err);
    return res.status(500).json({ success: false, message: 'Database error' });
  }
};

// ✅ Get Dashboard Statistics
exports.getDashboardStats = async (req, res) => {
  try {
    // Get counts from all main tables
    const [customerCount] = await db.query('SELECT COUNT(*) as count FROM customer');
    const [shopCount] = await db.query('SELECT COUNT(*) as count FROM shop');
    const [adminCount] = await db.query('SELECT COUNT(*) as count FROM admin');
    const [bookingCount] = await db.query('SELECT COUNT(*) as count FROM booking');
    
    // Get pending bookings
    const [pendingCount] = await db.query('SELECT COUNT(*) as count FROM booking WHERE status = ?', ['pending']);
    
    // Get today's bookings
    const today = new Date().toISOString().split('T')[0];
    const [todayCount] = await db.query('SELECT COUNT(*) as count FROM booking WHERE DATE(booking_date) = ?', [today]);
    
    // Get total revenue - skip if no price column exists
    let totalRevenue = 0;
    // Note: Revenue calculation disabled until proper price column is identified
    
    // Get active shops (shops that have at least one booking)
    const [activeShopsResult] = await db.query(`
      SELECT COUNT(DISTINCT shop_id) as count 
      FROM booking 
      WHERE shop_id IS NOT NULL
    `);
    
    // Recent activities - get latest bookings, customers, and shops
    let recentBookings = [];
    try {
      const [bookingResults] = await db.query(`
        SELECT b.*, s.name as shop_name, c.first_name, c.last_name
        FROM booking b 
        LEFT JOIN shop s ON b.shop_id = s.shop_id
        LEFT JOIN customer c ON b.customer_id = c.customer_id
        ORDER BY b.created_at DESC 
        LIMIT 5
      `);
      recentBookings = bookingResults;
    } catch (error) {
      console.log('Recent bookings query failed, using basic booking data');
      try {
        const [basicBookings] = await db.query('SELECT * FROM booking ORDER BY created_at DESC LIMIT 5');
        recentBookings = basicBookings;
      } catch (basicError) {
        recentBookings = [];
      }
    }
    
    let recentCustomers = [];
    let recentShops = [];
    
    try {
      const [customerResults] = await db.query(`
        SELECT customer_id, first_name, last_name, created_at 
        FROM customer 
        ORDER BY created_at DESC 
        LIMIT 3
      `);
      recentCustomers = customerResults;
    } catch (error) {
      console.log('Recent customers query failed');
      recentCustomers = [];
    }
    
    try {
      const [shopResults] = await db.query(`
        SELECT shop_id, name, admin_id as created_at 
        FROM shop 
        ORDER BY shop_id DESC 
        LIMIT 3
      `);
      recentShops = shopResults;
    } catch (error) {
      console.log('Recent shops query failed');
      recentShops = [];
    }

    // Format recent activities
    const activities = [];
    
    // Add recent bookings
    if (recentBookings && recentBookings.length > 0) {
      recentBookings.forEach(booking => {
        activities.push({
          action: `New booking${booking.shop_name ? ` at ${booking.shop_name}` : ''}`,
          time: formatTimeAgo(booking.created_at),
          color: '#8b5cf6',
          type: 'booking',
          timestamp: booking.created_at
        });
      });
    }
    
    // Add recent customers
    if (recentCustomers && recentCustomers.length > 0) {
      recentCustomers.forEach(customer => {
        activities.push({
          action: `New customer registered: ${customer.first_name} ${customer.last_name || ''}`,
          time: formatTimeAgo(customer.created_at),
          color: '#10b981',
          type: 'customer',
          timestamp: customer.created_at
        });
      });
    }
    
    // Add recent shops
    if (recentShops && recentShops.length > 0) {
      recentShops.forEach(shop => {
        const shopTs = shop.created_at || shop.createdAt || shop.registered_at || null;
        activities.push({
          action: `New shop registered: ${shop.name}`,
          time: shopTs ? formatTimeAgo(shopTs) : 'Unknown',
          color: '#3b82f6',
          type: 'shop',
          timestamp: shopTs ? shopTs : null
        });
      });
    }
    
    // Sort activities by timestamp and take latest 6
    activities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const recentActivities = activities.slice(0, 6);

    // System health (mock data for now)
    const systemHealth = [
      { service: 'API Server', status: 'Online', color: '#10b981' },
      { service: 'Database', status: 'Online', color: '#10b981' },
      { service: 'Payment Gateway', status: 'Online', color: '#10b981' },
      { service: 'Notifications', status: 'Online', color: '#10b981' }
    ];

    const stats = {
      totalCustomers: customerCount[0].count,
      totalShops: shopCount[0].count,
      activeShops: activeShopsResult[0].count,
      totalStaff: adminCount[0].count,
      totalBookings: bookingCount[0].count,
      todayBookings: todayCount[0].count,
      pendingBookings: pendingCount[0].count,
      totalRevenue: parseFloat(totalRevenue) || 0,
      recentActivities,
      systemHealth
    };

    res.json(stats);
  } catch (err) {
    console.error("DB Error (getDashboardStats):", err);
    res.status(500).json({ 
      message: "Database error", 
      error: err.message,
      // Return default stats on error
      totalCustomers: 0,
      totalShops: 0,
      activeShops: 0,
      totalStaff: 0,
      totalBookings: 0,
      todayBookings: 0,
      pendingBookings: 0,
      totalRevenue: 0,
      recentActivities: [],
      systemHealth: [
        { service: 'API Server', status: 'Error', color: '#ef4444' },
        { service: 'Database', status: 'Error', color: '#ef4444' },
        { service: 'Payment Gateway', status: 'Unknown', color: '#f59e0b' },
        { service: 'Notifications', status: 'Unknown', color: '#f59e0b' }
      ]
    });
  }
};

// Revenue analytics based on finalized payments
exports.getRevenueAnalytics = async (req, res) => {
  const toDate = req.query.to || new Date().toISOString().slice(0, 10);
  const defaultFrom = new Date(`${toDate}T00:00:00Z`);
  defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 29);
  const fromDate = req.query.from || defaultFrom.toISOString().slice(0, 10);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate) || fromDate > toDate) {
    return res.status(400).json({ message: 'Valid from and to dates are required.' });
  }

  try {
    const paidPaymentFilter = `
      p.date >= ? AND p.date < DATE_ADD(?, INTERVAL 1 DAY)
      AND LOWER(p.status) IN ('paid', 'success', 'succeeded', 'completed')
      AND LOWER(COALESCE(b.status, '')) NOT IN ('cancelled', 'canceled', 'rejected')
    `;
    const params = [fromDate, toDate];

    const [summaryRows] = await db.query(`
      SELECT COALESCE(SUM(p.amount), 0) AS total_revenue, COUNT(*) AS paid_payments,
             COUNT(DISTINCT p.booking_id) AS completed_bookings, COALESCE(AVG(p.amount), 0) AS average_payment
      FROM payment p LEFT JOIN booking b ON b.booking_id = p.booking_id
      WHERE ${paidPaymentFilter}
    `, params);
    const [dailyRows] = await db.query(`
      SELECT DATE(p.date) AS date, COALESCE(SUM(p.amount), 0) AS revenue, COUNT(*) AS payments
      FROM payment p LEFT JOIN booking b ON b.booking_id = p.booking_id
      WHERE ${paidPaymentFilter} GROUP BY DATE(p.date) ORDER BY DATE(p.date)
    `, params);
    const [methodRows] = await db.query(`
      SELECT COALESCE(NULLIF(p.payment_method, ''), 'Unknown') AS method,
             COALESCE(SUM(p.amount), 0) AS revenue, COUNT(*) AS payments
      FROM payment p LEFT JOIN booking b ON b.booking_id = p.booking_id
      WHERE ${paidPaymentFilter}
      GROUP BY COALESCE(NULLIF(p.payment_method, ''), 'Unknown') ORDER BY revenue DESC
    `, params);
    const [shopRows] = await db.query(`
      SELECT p.shop_id, COALESCE(s.name, CONCAT('Shop #', p.shop_id)) AS shop_name,
             COALESCE(SUM(p.amount), 0) AS revenue, COUNT(*) AS payments
      FROM payment p LEFT JOIN booking b ON b.booking_id = p.booking_id
      LEFT JOIN shop s ON s.shop_id = p.shop_id
      WHERE ${paidPaymentFilter}
      GROUP BY p.shop_id, s.name ORDER BY revenue DESC LIMIT 10
    `, params);

    const summary = summaryRows[0] || {};
    res.json({
      from: fromDate,
      to: toDate,
      summary: {
        totalRevenue: Number(summary.total_revenue || 0),
        paidPayments: Number(summary.paid_payments || 0),
        completedBookings: Number(summary.completed_bookings || 0),
        averagePayment: Number(summary.average_payment || 0)
      },
      daily: dailyRows.map(row => ({ date: row.date, revenue: Number(row.revenue || 0), payments: Number(row.payments || 0) })),
      paymentMethods: methodRows.map(row => ({ method: row.method, revenue: Number(row.revenue || 0), payments: Number(row.payments || 0) })),
      topShops: shopRows.map(row => ({ shopId: row.shop_id, shopName: row.shop_name, revenue: Number(row.revenue || 0), payments: Number(row.payments || 0) }))
    });
  } catch (err) {
    console.error('DB Error (getRevenueAnalytics):', err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

// Helper function to format time ago
function formatTimeAgo(dateString) {
  if (!dateString) return 'Unknown';
  
  try {
    const now = new Date();
    const date = new Date(dateString);
    
    // Check if date is valid
    if (isNaN(date.getTime())) return 'Unknown';
    
    const diffInMs = now - date;
    const diffInMins = Math.floor(diffInMs / (1000 * 60));
    const diffInHours = Math.floor(diffInMs / (1000 * 60 * 60));
    const diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));

    if (diffInMins < 1) return 'Just now';
    if (diffInMins < 60) return `${diffInMins} minute${diffInMins > 1 ? 's' : ''} ago`;
    if (diffInHours < 24) return `${diffInHours} hour${diffInHours > 1 ? 's' : ''} ago`;
    if (diffInDays < 7) return `${diffInDays} day${diffInDays > 1 ? 's' : ''} ago`;
    
    return date.toLocaleDateString();
  } catch (error) {
    return 'Unknown';
  }
}
