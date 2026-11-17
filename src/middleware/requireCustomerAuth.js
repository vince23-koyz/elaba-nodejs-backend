const jwt = require('jsonwebtoken');

const TOKEN_ISSUER = 'elaba-api';
const TOKEN_AUDIENCE = 'elaba-customer-app';

function requireCustomerAuth(req, res, next) {
  const authorization = req.get('authorization') || '';
  const match = authorization.match(/^Bearer ([^\s]+)$/i);
  if (!match) {
    return res.status(401).json({
      success: false,
      message: 'A valid customer login is required.',
    });
  }

  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret || Buffer.byteLength(jwtSecret, 'utf8') < 32) {
    console.error('JWT_SECRET is missing or too short; cannot verify customer access token');
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
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
    });
  } catch {
    return res.status(401).json({
      success: false,
      message: 'Customer login is invalid or expired. Please sign in again.',
    });
  }

  const customerId = Number(payload.customer_id);
  if (
    payload.token_type !== 'customer' ||
    !Number.isSafeInteger(customerId) ||
    customerId <= 0 ||
    payload.sub !== String(customerId)
  ) {
    return res.status(401).json({
      success: false,
      message: 'A valid customer login is required.',
    });
  }

  req.authenticatedCustomerId = customerId;
  return next();
}

module.exports = requireCustomerAuth;
