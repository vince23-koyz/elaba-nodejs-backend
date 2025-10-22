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
        ORDER BY b.booking_date DESC 
        LIMIT 5
      `);
      recentBookings = bookingResults;
    } catch (error) {
      console.log('Recent bookings query failed, using basic booking data');
      try {
        const [basicBookings] = await db.query('SELECT * FROM booking ORDER BY booking_date DESC LIMIT 5');
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
          time: formatTimeAgo(booking.booking_date),
          color: '#8b5cf6',
          type: 'booking',
          timestamp: booking.booking_date
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
        activities.push({
          action: `New shop registered: ${shop.name}`,
          time: 'Recently',
          color: '#3b82f6',
          type: 'shop',
          timestamp: new Date() // Use current date since shop table doesn't have created_at
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
