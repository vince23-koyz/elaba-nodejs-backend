// controllers/shopController.js
const db = require('../config/db');
const { sendNotification } = require('../service/notificationService');

// CREATE Shop
exports.createShop = async (req, res) => {
  const { name, address, website, owner_name, operation_hours, admin_id, status, pickup_delivery_enabled } = req.body;

  // For superadmin, admin_id is optional
  // Handle image upload - support Cloudinary (absolute URL) or local disk
  let logo = '';
  if (req.file) {
    const pathOrUrl = req.file.path;
    const isHttp = typeof pathOrUrl === 'string' && /^https?:\/\//.test(pathOrUrl);
    if (isHttp) {
      logo = pathOrUrl;
    } else {
      const filename = req.file.filename || (pathOrUrl ? pathOrUrl.split(/[\\/]/).pop() : `shop_${Date.now()}.jpg`);
      const baseUrl = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
      logo = `${baseUrl}/uploads/shop-images/${filename}`;
    }
  }
  // Default to 'pending' when creating a new shop unless explicitly provided
  const shopStatus = status || 'pending';
  const pickupDeliveryEnabled = typeof pickup_delivery_enabled !== 'undefined' ? Number(pickup_delivery_enabled) : 0;

  try {
    let sql, params;
    
    if (admin_id) {
      sql = `
        INSERT INTO shop 
          (name, address, website, owner_name, operation_hours, status, admin_id, logo, pickup_delivery_enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
      params = [name, address, website, owner_name, operation_hours, shopStatus, admin_id, logo, pickupDeliveryEnabled];
    } else {
      sql = `
        INSERT INTO shop 
          (name, address, website, owner_name, operation_hours, status, logo, pickup_delivery_enabled)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `;
      params = [name, address, website, owner_name, operation_hours, shopStatus, logo, pickupDeliveryEnabled];
    }

    const [result] = await db.query(sql, params);

    res.status(201).json({
      success: true,
      message: "Shop created successfully",
      shop_id: result.insertId,
      logo: logo,
      status: shopStatus,
    });

    // Notify superadmins in real-time
    try {
      const io = req.app && req.app.get ? req.app.get('io') : null;
      if (!io) return;
      io.to('role_superadmin').emit('shopCreated', {
        shopId: result.insertId,
        status: shopStatus,
        name: name,
        at: new Date().toISOString(),
      });
    } catch (emitErr) {
      console.error('Socket emit error (shopCreated):', emitErr);
    }
  } catch (err) {
    console.error("DB Error (createShop):", err);
    res.status(500).json({ error: err.message });
  }
};

// GET ALL Shops
exports.getShops = async (req, res) => {
  try {
    const [results] = await db.query('SELECT * FROM shop');
    res.json(results);
  } catch (err) {
    console.error("DB Error (getShops):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

// GET Shop by ID
exports.getShopById = async (req, res) => {
  const { id } = req.params;
  try {
    const [results] = await db.query('SELECT * FROM shop WHERE shop_id = ?', [id]);

    if (results.length === 0) return res.status(404).json({ message: 'Shop not found' });
    res.json(results[0]);
  } catch (err) {
    console.error("DB Error (getShopById):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

// Get shop by admin_id
exports.getShopByAdmin = async (req, res) => {
  const { admin_id } = req.params;
  try {
    const [results] = await db.query('SELECT * FROM shop WHERE admin_id = ? LIMIT 1', [admin_id]);

    if (results.length === 0) {
      return res.json({ shop: null });
    }
    res.json({ shop: results[0] });
  } catch (err) {
    console.error("DB Error (getShopByAdmin):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};

// REJECT pending shop and notify the shop owner
exports.rejectShop = async (req, res) => {
  const { id } = req.params;
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';

  try {
    const [shopRows] = await db.query(
      'SELECT shop_id, name, admin_id, status FROM shop WHERE shop_id = ? LIMIT 1',
      [id]
    );
    const shop = shopRows?.[0];

    if (!shop) {
      return res.status(404).json({ message: 'Shop not found' });
    }

    await db.query(
      'UPDATE shop SET status = ?, rejection_reason = ? WHERE shop_id = ?',
      ['rejected', reason || null, id]
    );

    const message = reason
      ? `Shop registration rejected for ${shop.name || 'your shop'}. Reason: ${reason}. Please review and reapply.`
      : `Shop registration rejected for ${shop.name || 'your shop'}. Please review and reapply.`;

    if (shop.admin_id) {
      try {
        const { savedNotification } = await sendNotification({
          accountId: shop.admin_id,
          accountType: 'admin',
          title: 'Shop request rejected',
          message
        });

        const io = req.app && req.app.get ? req.app.get('io') : null;
        if (io && savedNotification) {
          io.to(`user_admin_${shop.admin_id}`).emit('newNotification', savedNotification);
        }
      } catch (notificationError) {
        console.error('Shop rejection notification error:', notificationError);
      }
    }

    const io = req.app && req.app.get ? req.app.get('io') : null;
    if (io) {
      io.to('role_superadmin').emit('shopUpdated', {
        shopId: Number(id),
        status: 'rejected',
        at: new Date().toISOString(),
      });
      if (shop.admin_id) {
        io.to(`user_admin_${shop.admin_id}`).emit('shopStatusUpdated', {
          shopId: Number(id),
          adminId: Number(shop.admin_id),
          status: 'rejected',
          rejectionReason: reason || null,
          at: new Date().toISOString(),
        });
      }
    }

    res.json({
      success: true,
      message: 'Shop rejected successfully',
      status: 'rejected',
      rejection_reason: reason || null
    });
  } catch (err) {
    console.error('DB Error (rejectShop):', err);
    res.status(500).json({ message: 'Failed to reject shop', error: err.message });
  }
};

// UPDATE Shop
exports.updateShop = async (req, res) => {
  const { id } = req.params;
  const { name, address, website, owner_name, operation_hours, status, pickup_delivery_enabled } = req.body;

  console.log('Updating shop ID:', id);
  console.log('Request body:', req.body);
  console.log('Has file:', !!req.file);

  try {
    const [existingRows] = await db.query('SELECT * FROM shop WHERE shop_id = ? LIMIT 1', [id]);
    const existingShop = existingRows && existingRows[0] ? existingRows[0] : null;

    if (!existingShop) {
      return res.status(404).json({ message: 'Shop not found' });
    }

    const normalizedPickupValue = typeof pickup_delivery_enabled !== 'undefined' ? Number(pickup_delivery_enabled) : undefined;
    const updateFields = [];
    const params = [];

    const addField = (fieldName, value, fallbackValue) => {
      const finalValue = typeof value === 'undefined' ? fallbackValue : value;

      if (['name', 'address', 'owner_name', 'operation_hours'].includes(fieldName)) {
        if (typeof finalValue === 'string' && finalValue.trim() === '') {
          return;
        }
      }

      if (typeof finalValue !== 'undefined' && finalValue !== null) {
        updateFields.push(`${fieldName}=?`);
        params.push(finalValue);
      }
    };

    // Preserve existing shop meta when a frontend request only toggles pickup.
    addField('name', name, existingShop.name);
    addField('address', address, existingShop.address);
    addField('website', website, existingShop.website);
    addField('owner_name', owner_name, existingShop.owner_name);
    addField('operation_hours', operation_hours, existingShop.operation_hours);

    if (req.file) {
      const pathOrUrl = req.file.path;
      const isHttp = typeof pathOrUrl === 'string' && /^https?:\/\//.test(pathOrUrl);
      const logoPath = isHttp
        ? pathOrUrl
        : `${process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`}/uploads/shop-images/${req.file.filename || (pathOrUrl ? pathOrUrl.split(/[\\/]/).pop() : `shop_${Date.now()}.jpg`)}`;
      addField('logo', logoPath, existingShop.logo);
    }

    addField('status', status, existingShop.status);
    if (status === 'pending' && existingShop.status === 'rejected') {
      updateFields.push('rejection_reason=?');
      params.push(null);
    }
    if (typeof normalizedPickupValue !== 'undefined') {
      updateFields.push('pickup_delivery_enabled=?');
      params.push(normalizedPickupValue);
    }

    if (updateFields.length === 0) {
      return res.status(400).json({ message: 'No valid shop fields provided for update.' });
    }

    params.push(id);
    const sql = `UPDATE shop SET ${updateFields.join(', ')} WHERE shop_id=?`;

    console.log('Executing SQL:', sql);
    console.log('With params:', params);

    const [result] = await db.query(sql, params);
    console.log('Update result:', result);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Shop not found' });
    }

    const responseData = { message: 'Shop updated successfully' };
    if (req.file) {
      responseData.logo = `/uploads/shop-images/${req.file.filename}`;
    }
    if (typeof status !== 'undefined') {
      responseData.status = status;
    }
    if (typeof normalizedPickupValue !== 'undefined') {
      responseData.pickup_delivery_enabled = normalizedPickupValue;
    }
    if (typeof name !== 'undefined') {
      responseData.name = name;
    }

    console.log('Sending response:', responseData);
    res.json(responseData);

    try {
      const io = req.app && req.app.get ? req.app.get('io') : null;
      if (io) {
        io.to('role_superadmin').emit('shopUpdated', {
          shopId: Number(id),
          status: typeof status !== 'undefined' ? status : undefined,
          at: new Date().toISOString(),
        });

        if (typeof status !== 'undefined' && existingShop.admin_id) {
          io.to(`user_admin_${existingShop.admin_id}`).emit('shopStatusUpdated', {
            shopId: Number(id),
            adminId: Number(existingShop.admin_id),
            status,
            at: new Date().toISOString(),
          });
        }
      }
    } catch (emitErr) {
      console.error('Socket emit error (shopUpdated):', emitErr);
    }
  } catch (err) {
    console.error("DB Error (updateShop):", err);
    console.error("Error details:", {
      message: err.message,
      code: err.code,
      errno: err.errno,
      sqlState: err.sqlState,
      sqlMessage: err.sqlMessage
    });
    res.status(500).json({ message: 'Database error', error: err.message, details: err });
  }
};

// DELETE Shop
exports.deleteShop = async (req, res) => {
  const { id } = req.params;
  try {
    const [result] = await db.query('DELETE FROM shop WHERE shop_id = ?', [id]);

    if (result.affectedRows === 0) return res.status(404).json({ message: 'Shop not found' });
    res.json({ message: 'Shop deleted successfully' });

    const io = req.app && req.app.get ? req.app.get('io') : null;
    if (io) {
      io.to('role_superadmin').emit('shopDeleted', {
        shopId: Number(id),
        at: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error("DB Error (deleteShop):", err);
    res.status(500).json({ message: 'Database error', error: err.message });
  }
};
