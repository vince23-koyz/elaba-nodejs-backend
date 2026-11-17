const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const queryCalls = [];
const db = {
  async query(sql, params) {
    queryCalls.push({ sql, params });
    if (sql.includes('FROM customer')) return [[{ customer_id: params[0] }]];
    if (sql.includes('FROM admin')) return [[{ admin_id: params[0] }]];
    throw new Error('Unexpected mocked query');
  },
};
const dbPath = require.resolve('../src/config/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };

const { createTokenPair } = require('../src/utils/authTokenService');
const customerController = require('../src/controllers/customerController');
const adminController = require('../src/controllers/adminController');

const testSecret = 'test-secret-that-is-long-enough-for-jwt-signing';

function makeResponse() {
  return {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test('refresh endpoints renew expired access sessions for the matching account only', async () => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = testSecret;
  queryCalls.length = 0;
  try {
    const customerTokens = createTokenPair('customer', 31);
    const customerResponse = makeResponse();
    await customerController.refreshCustomerToken(
      { body: { refresh_token: customerTokens.refreshToken } },
      customerResponse,
    );
    assert.equal(customerResponse.statusCode, 200);
    const customerAccess = jwt.verify(customerResponse.body.token, testSecret, {
      algorithms: ['HS256'],
      issuer: 'elaba-api',
      audience: 'elaba-customer-app',
    });
    assert.equal(customerAccess.customer_id, 31);
    assert.equal(customerAccess.token_type, 'customer');

    const adminTokens = createTokenPair('admin', 42);
    const adminResponse = makeResponse();
    await adminController.refreshAdminToken(
      { body: { refresh_token: adminTokens.refreshToken } },
      adminResponse,
    );
    assert.equal(adminResponse.statusCode, 200);
    const adminAccess = jwt.verify(adminResponse.body.token, testSecret, {
      algorithms: ['HS256'],
      issuer: 'elaba-api',
      audience: 'elaba-staff-app',
    });
    assert.equal(adminAccess.admin_id, 42);
    assert.equal(adminAccess.token_type, 'admin');
    assert.equal(queryCalls.length, 2);
  } finally {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
});

test('refresh endpoints reject expired tokens without database access', async () => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = testSecret;
  queryCalls.length = 0;
  try {
    const expiredCustomerToken = jwt.sign(
      { customer_id: 31, token_type: 'customer_refresh' },
      testSecret,
      {
        algorithm: 'HS256',
        issuer: 'elaba-api',
        audience: 'elaba-customer-refresh',
        subject: '31',
        expiresIn: -1,
      },
    );
    const response = makeResponse();
    await customerController.refreshCustomerToken(
      { body: { refresh_token: expiredCustomerToken } },
      response,
    );
    assert.equal(response.statusCode, 401);
    assert.equal(queryCalls.length, 0);
  } finally {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  }
});
