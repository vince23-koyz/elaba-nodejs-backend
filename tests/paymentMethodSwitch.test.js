const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

let qrPhStatus = 'pending';
let cancellationFails = false;
let cancellationCalls = 0;
const paymentUpdates = [];

const dbMock = {
  getConnection: async () => ({
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
    query: async (sql, params) => {
      if (sql.includes('SELECT b.booking_id') && sql.includes('FROM booking b')) {
        return [[{
          booking_id: 42,
          customer_id: 8,
          shop_id: 3,
          service_id: 2,
          booking_type: 'Pick up',
          status: 'processing',
          total_amount: 230,
          price_confirmation_status: 'confirmed',
          delivery_status: 'out_for_delivery',
        }]];
      }
      if (sql.includes('SELECT payment_id, payment_method, status, paymongo_payment_id')) {
        return [[{
          payment_id: 99,
          payment_method: 'qrph',
          status: 'pending',
          paymongo_payment_id: 'pi_test',
        }]];
      }
      if (sql.includes('UPDATE payment')) {
        paymentUpdates.push({ sql, params });
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected SQL in payment-method test: ${sql}`);
    },
  }),
  query: async (sql) => {
    if (sql.includes('SELECT s.admin_id')) return [[{ admin_id: 4 }]];
    return [[]];
  },
};

const paymongoMock = {
  getQrPhPayment: async () => ({
    success: true,
    data: { status: qrPhStatus },
  }),
  cancelQrPhPayment: async () => {
    cancellationCalls += 1;
    if (cancellationFails) {
      return { success: false, error: 'PayMongo could not cancel the active QR Ph code' };
    }
    qrPhStatus = 'failed';
    return { success: true, data: { status: 'failed' } };
  },
};

const originalLoad = Module._load;
Module._load = function (request) {
  if (request === '../config/db') return dbMock;
  if (request === '../service/notificationService') return { sendNotification: async () => {} };
  if (request === '../service/paymongoService') return paymongoMock;
  if (request === './deliveryController') return {};
  return originalLoad.apply(this, arguments);
};
const bookingController = require('../src/controllers/bookingController');
Module._load = originalLoad;

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

function makeRequest() {
  return {
    params: { id: '42' },
    authenticatedCustomerId: 8,
    body: { payment_method: 'cash' },
    app: { get: () => ({ to: () => ({ emit: () => {} }) }) },
  };
}

test('cancels the active QR Ph intent before switching to COD', async () => {
  qrPhStatus = 'pending';
  cancellationFails = false;
  cancellationCalls = 0;
  paymentUpdates.length = 0;
  const res = makeResponse();

  await bookingController.selectLaundryRequestPaymentMethod(makeRequest(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.payment_method, 'cod');
  assert.equal(cancellationCalls, 1);
  assert.equal(paymentUpdates.length, 1);
  assert.equal(paymentUpdates[0].params[0], 'cod');
  assert.match(paymentUpdates[0].sql, /paymongo_payment_id = NULL/);
});

test('does not switch to COD if PayMongo cannot cancel the active QR Ph intent', async () => {
  qrPhStatus = 'pending';
  cancellationFails = true;
  cancellationCalls = 0;
  paymentUpdates.length = 0;
  const res = makeResponse();

  await bookingController.selectLaundryRequestPaymentMethod(makeRequest(), res);

  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /could not cancel/i);
  assert.equal(cancellationCalls, 1);
  assert.equal(paymentUpdates.length, 0);
});

test('allows switching to COD after PayMongo confirms the QR Ph code expired', async () => {
  qrPhStatus = 'expired';
  cancellationFails = false;
  cancellationCalls = 0;
  paymentUpdates.length = 0;
  const res = makeResponse();

  await bookingController.selectLaundryRequestPaymentMethod(makeRequest(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.payment_method, 'cod');
  assert.equal(cancellationCalls, 0);
  assert.equal(paymentUpdates.length, 1);
  assert.equal(paymentUpdates[0].params[0], 'cod');
  assert.match(paymentUpdates[0].sql, /paymongo_payment_id = NULL/);
});
