const jwt = require('jsonwebtoken');

const TOKEN_ISSUER = 'elaba-api';
const ACCOUNT_CONFIG = {
  customer: {
    idClaim: 'customer_id',
    audience: 'elaba-customer-app',
    refreshAudience: 'elaba-customer-refresh',
  },
  admin: {
    idClaim: 'admin_id',
    audience: 'elaba-staff-app',
    refreshAudience: 'elaba-staff-refresh',
  },
};

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('JWT_SECRET is missing or too short');
  }
  return secret;
}

function createTokenPair(accountType, accountId) {
  return {
    accessToken: createAccessToken(accountType, accountId),
    refreshToken: createRefreshToken(accountType, accountId),
  };
}

function createAccessToken(accountType, accountId) {
  const config = ACCOUNT_CONFIG[accountType];
  if (!config) throw new Error('Unsupported account type');

  const id = Number(accountId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid account ID');

  const secret = getJwtSecret();
  const claims = {
    [config.idClaim]: id,
    token_type: accountType,
  };
  const subject = String(id);

  return jwt.sign(claims, secret, {
    algorithm: 'HS256',
    expiresIn: '1h',
    issuer: TOKEN_ISSUER,
    audience: config.audience,
    subject,
  });
}

function createRefreshToken(accountType, accountId) {
  const config = ACCOUNT_CONFIG[accountType];
  if (!config) throw new Error('Unsupported account type');

  const id = Number(accountId);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid account ID');

  return jwt.sign(
    { [config.idClaim]: id, token_type: `${accountType}_refresh` },
    getJwtSecret(),
    {
      algorithm: 'HS256',
      expiresIn: '30d',
      issuer: TOKEN_ISSUER,
      audience: config.refreshAudience,
      subject: String(id),
    },
  );
}

function verifyRefreshToken(accountType, token) {
  const config = ACCOUNT_CONFIG[accountType];
  if (!config) throw new Error('Unsupported account type');

  const payload = jwt.verify(token, getJwtSecret(), {
    algorithms: ['HS256'],
    issuer: TOKEN_ISSUER,
    audience: config.refreshAudience,
  });
  const accountId = Number(payload[config.idClaim]);
  if (
    payload.token_type !== `${accountType}_refresh` ||
    !Number.isSafeInteger(accountId) ||
    accountId <= 0 ||
    payload.sub !== String(accountId)
  ) {
    throw new Error('Invalid refresh token');
  }
  return accountId;
}

module.exports = { createTokenPair, createAccessToken, verifyRefreshToken };
