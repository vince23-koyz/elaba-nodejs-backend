// controllers/shopController.js
const db = require('../config/db');
const { sendNotification } = require('../service/notificationService');
const { shouldResetShopForResubmission } = require('../utils/shopResubmission');

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

const DOCUMENT_FIELDS = new Set(['business_permit', 'dti_registration', 'sec_registration']);

async function getShopDocumentReviewState(shopId) {
  const [documents] = await db.query(
    `SELECT document_type, status, document_id, uploaded_at
     FROM shop_documents
     WHERE shop_id = ?
       AND document_type IN ('business_permit', 'dti_registration', 'sec_registration')
     ORDER BY uploaded_at DESC, document_id DESC`,
    [shopId]
  );

  const latestByType = new Map();
  for (const document of documents) {
    const type = document.document_type;
    if (!latestByType.has(type)) {
      latestByType.set(type, []);
    }
    latestByType.get(type).push(document);
  }

  const effectiveStatuses = {};
  for (const [type, typeDocs] of latestByType.entries()) {
    const hasApproved = typeDocs.some(document => document.status === 'approved');
    const hasRejected = typeDocs.some(document => document.status === 'rejected');
    const hasPending = typeDocs.some(document => document.status === 'pending');

    if (hasApproved) {
      effectiveStatuses[type] = 'approved';
    } else if (hasRejected) {
      effectiveStatuses[type] = 'rejected';
    } else if (hasPending) {
      effectiveStatuses[type] = 'pending';
    } else {
      effectiveStatuses[type] = 'unknown';
    }
  }

  const effectiveDocs = Object.entries(effectiveStatuses).map(([document_type, status]) => ({
    document_type,
    status,
  }));

  return {
    hasDocuments: effectiveDocs.length > 0,
    allReviewed: effectiveDocs.length > 0 && effectiveDocs.every(document => document.status !== 'pending' && document.status !== 'unknown'),
    allApproved: effectiveDocs.length > 0 && effectiveDocs.every(document => document.status === 'approved'),
    hasRejectedDocument: effectiveDocs.some(document => document.status === 'rejected'),
    permitApproved: effectiveDocs.some(document => document.document_type === 'business_permit' && document.status === 'approved'),
  };
}

function getUploadedFileUrl(req, file) {
  const pathOrUrl = file.path;
  if (typeof pathOrUrl === 'string' && /^https?:\/\//.test(pathOrUrl)) {
    return pathOrUrl;
  }

  const fallbackBaseUrl = process.env.PUBLIC_BASE_URL || 'http://localhost:5000';
  const host = req.get ? req.get('host') : '';
  const normalizedHost = String(host || '').replace(/:\d+$/, '');
  const isEmulatorHost = ['10.0.2.2', 'localhost', '127.0.0.1', '::1'].includes(normalizedHost);
  const baseUrl = isEmulatorHost && !process.env.PUBLIC_BASE_URL ? fallbackBaseUrl : (process.env.PUBLIC_BASE_URL || `${req.protocol}://${host}`);
  const filename = file.filename || (pathOrUrl ? pathOrUrl.split(/[\\/]/).pop() : null);

  return filename ? `${baseUrl.replace(/\/$/, '')}/uploads/shop-documents/${filename}` : null;
}

// Upload one or more shop verification documents.
exports.uploadShopDocuments = async (req, res) => {
  const { id: shopId } = req.params;
  const files = Object.values(req.files || {}).flat();

  if (!files.length) {
    return res.status(400).json({ message: 'At least one verification document is required.' });
  }

  if (!files.some(file => file.fieldname === 'business_permit')) {
    return res.status(400).json({ message: 'Business/Mayor’s Permit is required.' });
  }

  const invalidField = files.find(file => !DOCUMENT_FIELDS.has(file.fieldname));
  if (invalidField) {
    return res.status(400).json({ message: `Unsupported document type: ${invalidField.fieldname}` });
  }

  try {
    const [shopRows] = await db.query('SELECT shop_id FROM shop WHERE shop_id = ? LIMIT 1', [shopId]);
    if (!shopRows[0]) {
      return res.status(404).json({ message: 'Shop not found' });
    }

    const uniqueDocumentTypes = [...new Set(files.map(file => file.fieldname).filter(field => DOCUMENT_FIELDS.has(field)))];
    if (uniqueDocumentTypes.length > 0) {
      await db.query(
        `DELETE FROM shop_documents
         WHERE shop_id = ?
           AND document_type IN (?)`,
        [shopId, uniqueDocumentTypes]
      );
    }

    const documents = [];
    for (const file of files) {
      const fileUrl = getUploadedFileUrl(req, file);
      const [result] = await db.query(
        `INSERT INTO shop_documents
          (shop_id, document_type, file_url, original_filename, mime_type, file_size, status)
         VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
        [shopId, file.fieldname, fileUrl, file.originalname, file.mimetype, file.size || null]
      );

      documents.push({
        document_id: result.insertId,
        shop_id: Number(shopId),
        document_type: file.fieldname,
        file_url: fileUrl,
        status: 'pending',
      });
    }

    const [shopStateRows] = await db.query('SELECT status, admin_id FROM shop WHERE shop_id = ? LIMIT 1', [shopId]);
    const currentShopState = shopStateRows?.[0];
    if (currentShopState && currentShopState.status === 'rejected') {
      await db.query('UPDATE shop SET status = ?, rejection_reason = NULL WHERE shop_id = ?', ['pending', shopId]);

      const io = req.app && req.app.get ? req.app.get('io') : null;
      if (io && currentShopState.admin_id) {
        io.to(`user_admin_${currentShopState.admin_id}`).emit('shopStatusUpdated', {
          shopId: Number(shopId),
          adminId: Number(currentShopState.admin_id),
          status: 'pending',
          at: new Date().toISOString(),
        });
      }
    }

    res.status(201).json({
      success: true,
      message: 'Verification documents uploaded successfully.',
      documents,
    });
  } catch (err) {
    console.error('DB Error (uploadShopDocuments):', err);
    res.status(500).json({ message: 'Failed to save verification documents.', error: err.message });
  }
};

// List verification documents for a shop.
exports.getShopDocuments = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT document_id, shop_id, document_type, file_url, original_filename,
              mime_type, file_size, status, rejection_reason, uploaded_at,
              reviewed_at, reviewed_by
       FROM shop_documents
       WHERE shop_id = ?
       ORDER BY uploaded_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('DB Error (getShopDocuments):', err);
    res.status(500).json({ message: 'Failed to load verification documents.', error: err.message });
  }
};

// Review one verification document.
exports.reviewShopDocument = async (req, res) => {
  const { id: documentId } = req.params;
  const { status, rejection_reason, reviewed_by } = req.body || {};

  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ message: 'Document status must be approved or rejected.' });
  }

  if (status === 'rejected' && !String(rejection_reason || '').trim()) {
    return res.status(400).json({ message: 'A rejection reason is required.' });
  }

  try {
    const [documentRows] = await db.query(
      `SELECT sd.document_id, sd.shop_id, sd.document_type, sd.file_url, s.admin_id, s.name AS shop_name
       FROM shop_documents sd
       LEFT JOIN shop s ON s.shop_id = sd.shop_id
       WHERE sd.document_id = ? LIMIT 1`,
      [documentId]
    );
    const documentInfo = documentRows && documentRows[0] ? documentRows[0] : null;

    const [result] = await db.query(
      `UPDATE shop_documents
       SET status = ?, rejection_reason = ?, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ?
       WHERE document_id = ?`,
      [status, status === 'rejected' ? String(rejection_reason).trim() : null, reviewed_by || null, documentId]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ message: 'Verification document not found.' });
    }

    if (status === 'rejected' && documentInfo?.admin_id) {
      const label = documentInfo.document_type === 'business_permit'
        ? 'Business / Mayor’s Permit'
        : documentInfo.document_type === 'dti_registration'
          ? 'DTI Registration'
          : documentInfo.document_type === 'sec_registration'
            ? 'SEC Registration'
            : 'Verification document';

      const message = `${label} was rejected. Please review the reason and re-upload the correct file.`;
      try {
        await sendNotification({
          accountId: documentInfo.admin_id,
          accountType: 'admin',
          title: 'Verification document rejected',
          message,
        });
      } catch (notificationError) {
        console.error('Document rejection notification error:', notificationError);
      }
    }

    res.json({
      success: true,
      message: `Document ${status} successfully.`,
      status,
    });
  } catch (err) {
    console.error('DB Error (reviewShopDocument):', err);
    res.status(500).json({ message: 'Failed to review verification document.', error: err.message });
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

    const documentReview = await getShopDocumentReviewState(id);
    if (!documentReview.hasDocuments || !documentReview.allReviewed) {
      return res.status(400).json({ message: 'Review all shop documents before deciding on the shop registration.' });
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

    if (status === 'active') {
      const documentReview = await getShopDocumentReviewState(id);
      if (!documentReview.hasDocuments || !documentReview.allReviewed) {
        return res.status(400).json({
          message: 'Review all shop documents before approving the shop.',
        });
      }

      if (documentReview.hasRejectedDocument) {
        return res.status(400).json({
          message: 'Shop cannot be approved because one or more verification documents were rejected.',
        });
      }

      if (!documentReview.permitApproved || !documentReview.allApproved) {
        return res.status(400).json({
          message: 'Shop cannot be approved until the Business/Mayor’s Permit and all required verification documents are approved.',
        });
      }
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

    const shouldResetToPending = shouldResetShopForResubmission({
      existingStatus: existingShop.status,
      requestedStatus: status,
    });

    addField('status', status, shouldResetToPending ? 'pending' : existingShop.status);
    if (shouldResetToPending) {
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
    if (typeof status !== 'undefined' || shouldResetToPending) {
      responseData.status = shouldResetToPending ? 'pending' : status;
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

        if ((typeof status !== 'undefined' || shouldResetToPending) && existingShop.admin_id) {
          io.to(`user_admin_${existingShop.admin_id}`).emit('shopStatusUpdated', {
            shopId: Number(id),
            adminId: Number(existingShop.admin_id),
            status: shouldResetToPending ? 'pending' : status,
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
