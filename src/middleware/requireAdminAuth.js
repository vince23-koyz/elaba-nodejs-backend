const jwt = require('jsonwebtoken');

function requireAdminAuth(req, res, next) {
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer\s+(\S+)$/i);
  if (!match) {
    return res.status(401).json({
      success: false,
      message: 'A valid staff login is required.',
    });
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || Buffer.byteLength(jwtSecret, 'utf8') < 32) {
    console.error('JWT_SECRET is missing or too short; cannot verify admin access token');
    return res.status(503).json({
      success: false,
      code: 'AUTH_UNAVAILABLE',
      message: 'Authentication is temporarily unavailable. Please try again later.',
    });
  }

  let payload;
  try {
    payload = jwt.verify(match[1], jwtSecret, {
      algorithms: ['HS256'],
      issuer: 'elaba-api',
      audience: 'elaba-staff-app',
    });
  } catch {
    return res.status(401).json({
      success: false,
      message: 'Staff login is invalid or expired. Please sign in again.',
    });
  }

  const adminId = Number(payload.admin_id);
  if (
    payload.token_type !== 'admin' ||
    !Number.isSafeInteger(adminId) ||
    adminId <= 0 ||
    payload.sub !== String(adminId)
  ) {
    return res.status(401).json({
      success: false,
      message: 'A valid staff login is required.',
    });
  }

  req.authenticatedAdminId = adminId;
  return next();
}

module.exports = requireAdminAuth;
