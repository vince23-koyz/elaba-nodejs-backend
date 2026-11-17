const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const {
  createTokenPair,
  verifyRefreshToken,
} = require('../src/utils/authTokenService');
const requireCustomerAuth = require('../src/middleware/requireCustomerAuth');
const requireAdminAuth = require('../src/middleware/requireAdminAuth');

const testSecret = 'test-secret-that-is-long-enough-for-jwt-signing';

test('issues bounded, separate customer and staff access/refresh tokens', () => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = testSecret;
  try {
    for (const [type, idClaim, accessAudience, refreshAudience, id] of [
      ['customer', 'customer_id', 'elaba-customer-app', 'elaba-customer-refresh', 31],
      ['admin', 'admin_id', 'elaba-staff-app', 'elaba-staff-refresh', 42],
    ]) {
      const { accessToken, refreshToken } = createTokenPair(type, id);
      const access = jwt.verify(accessToken, testSecret, {
        algorithms: ['HS256'],
        issuer: 'elaba-api',
        audience: accessAudience,
      });
      const refresh = jwt.verify(refreshToken, testSecret, {
        algorithms: ['HS256'],
        issuer: 'elaba-api',
        audience: refreshAudience,
      });

      assert.equal(access[idClaim], id);
      assert.equal(access.token_type, type);
      assert.ok(access.exp - access.iat <= 60 * 60);
      assert.equal(refresh[idClaim], id);
      assert.equal(refresh.token_type, `${type}_refresh`);
      assert.ok(refresh.exp - refresh.iat <= 30 * 24 * 60 * 60);
      assert.equal(verifyRefreshToken(type, refreshToken), id);
    }
  } finally {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
});

test('does not accept a customer refresh token as a staff session', () => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = testSecret;
  try {
    const { refreshToken } = createTokenPair('customer', 31);
    assert.throws(() => verifyRefreshToken('admin', refreshToken));
  } finally {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
});

test('access-token middleware rejects expired tokens without bypassing verification', () => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = testSecret;
  try {
    const cases = [
      [requireCustomerAuth, {
        customer_id: 31,
        token_type: 'customer',
        audience: 'elaba-customer-app',
      }],
      [requireAdminAuth, {
        admin_id: 42,
        token_type: 'admin',
        audience: 'elaba-staff-app',
      }],
    ];

    for (const [middleware, claims] of cases) {
      const token = jwt.sign(
        { [claims.audience.includes('customer') ? 'customer_id' : 'admin_id']: claims.customer_id || claims.admin_id,
          token_type: claims.token_type },
        testSecret,
        {
          algorithm: 'HS256',
          issuer: 'elaba-api',
          audience: claims.audience,
          subject: String(claims.customer_id || claims.admin_id),
          expiresIn: -1,
        },
      );
      let nextCalled = false;
      const response = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
      };

      middleware({ get: () => `Bearer ${token}` }, response, () => { nextCalled = true; });
      assert.equal(nextCalled, false);
      assert.equal(response.statusCode, 401);
    }
  } finally {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
});
