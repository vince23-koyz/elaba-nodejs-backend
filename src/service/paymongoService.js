const axios = require('axios');
const { v4: uuid } = require('uuid');

class PayMongoService {
  constructor() {
    this.secretKey = process.env.PAYMONGO_SECRET_KEY || '';
    this.publicKey = process.env.PAYMONGO_PUBLIC_KEY || '';
  this.mode = (process.env.PAYMONGO_MODE || 'mock').toLowerCase(); // 'live' | 'test' | 'sandbox' | 'mock'
  if (this.mode === 'sandbox') this.mode = 'test'; // alias
    const envUseSessions = process.env.PAYMONGO_USE_CHECKOUT_SESSIONS;
    // Default to true in test mode if not explicitly set
    this.useCheckoutSessions = envUseSessions
      ? String(envUseSessions).toLowerCase() === 'true'
      : (this.mode === 'test');
    this.baseURL = 'https://api.paymongo.com/v1';

    // In-memory mock storage
    this._mockIntents = new Map();
    // In-memory checkout session status (sandbox/test)
    this._checkoutSessionsStatus = new Map(); // id -> 'processing' | 'succeeded' | 'canceled'

    if (this.isRealMode()) {
      // Axios clients only if real mode
      this.secretClient = axios.create({
        baseURL: this.baseURL,
        auth: { username: this.secretKey, password: '' },
        headers: { 'Content-Type': 'application/json' }
      });
      this.publicClient = axios.create({
        baseURL: this.baseURL,
        auth: { username: this.publicKey, password: '' },
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  isRealMode() {
    return this.mode !== 'mock' && this.secretKey && this.publicKey;
  }

  // ---------------- MOCK IMPLEMENTATION ----------------
  _createMockGCashPayment(amount, description, customerInfo, bookingId) {
    const id = `pi_mock_${uuid()}`;
    const paymentMethodId = `pm_mock_${uuid()}`;
    const intent = {
      id,
      amount: Math.round(amount * 100),
      description,
      customer: customerInfo,
      bookingId: bookingId || null,
      status: 'processing', // initial
      created_at: Date.now(),
  // No real redirect in mock mode; let frontend auto-poll and display processing
  next_action: { redirect: { url: null } }
    };
    this._mockIntents.set(id, intent);
    // Auto-complete after 3 seconds
    setTimeout(() => {
      const current = this._mockIntents.get(id);
      if (current && current.status === 'processing') {
        current.status = 'succeeded';
        this._mockIntents.set(id, current);
      }
    }, 3000);
    return {
      success: true,
      data: {
        paymentIntentId: id,
        paymentMethodId,
  redirectUrl: intent.next_action.redirect.url, // null in mock
        clientKey: `client_mock_${uuid()}`,
        status: intent.status,
        amount: intent.amount,
        currency: 'PHP'
      }
    };
  }

  _mockStatus(paymentIntentId) {
    const intent = this._mockIntents.get(paymentIntentId);
    if (!intent) {
      return { success: false, error: 'Payment intent not found' };
    }
    return { success: true, status: intent.status, data: intent };
  }

  // ---------------- REAL IMPLEMENTATION HELPERS ----------------
  async _getCheckoutSession(sessionId) {
    const response = await this.secretClient.get(`/checkout_sessions/${sessionId}`);
    return response.data?.data;
  }
  // Test/Sandbox: Checkout Sessions (preferred for GCash in sandbox)
  async _createCheckoutSession(amount, description, customerInfo) {
    // Use example.com success/cancel URLs by default (matches common sandbox demos)
    const successUrl = process.env.PAYMONGO_SUCCESS_URL || 'https://example.com/success';
    const cancelUrl = process.env.PAYMONGO_CANCEL_URL || 'https://example.com/cancel';
    const response = await this.secretClient.post('/checkout_sessions', {
      data: {
        attributes: {
          payment_method_types: ['gcash'],
          line_items: [
            {
              amount: Math.round(amount * 100),
              currency: 'PHP',
              name: description || 'eLaba GCash Payment',
              quantity: 1
            }
          ],
          description: description || 'eLaba GCash Payment',
          send_email_receipt: false,
          customer_email: customerInfo?.email || undefined,
          customer_name: customerInfo?.name || undefined,
          // Use uppercase, simple descriptor to satisfy provider rules
          statement_descriptor: 'ELABA',
          success_url: successUrl,
          cancel_url: cancelUrl
        }
      }
    });
    const session = response.data?.data;
    if (session?.id) {
      this._checkoutSessionsStatus.set(session.id, 'processing');
    }
    return session;
  }
  async _createPaymentIntent(amount, description, metadata = {}) {
    const response = await this.secretClient.post('/payment_intents', {
      data: {
        attributes: {
          amount: Math.round(amount * 100),
          payment_method_allowed: ['gcash'],
          currency: 'PHP',
          description,
          // Use uppercase, simple descriptor to satisfy provider rules
          statement_descriptor: 'ELABA',
          metadata
        }
      }
    });
    return response.data.data;
  }

  async _createGCashPaymentMethod(customerInfo) {
    const response = await this.publicClient.post('/payment_methods', {
      data: {
        attributes: {
          type: 'gcash',
          billing: {
            name: customerInfo.name,
            email: customerInfo.email,
            phone: customerInfo.phone
          }
        }
      }
    });
    return response.data.data;
  }

  async _attachPaymentMethod(paymentIntentId, paymentMethodId, returnUrl) {
    const response = await this.secretClient.post(`/payment_intents/${paymentIntentId}/attach`, {
      data: { attributes: { payment_method: paymentMethodId, return_url: returnUrl } }
    });
    return response.data.data;
  }

  async _getPaymentIntent(paymentIntentId) {
    const response = await this.secretClient.get(`/payment_intents/${paymentIntentId}`);
    return response.data.data;
  }

  // ---------------- PUBLIC API ----------------
  async createGCashPayment(amount, description, customerInfo, bookingId) {
    if (!amount || amount <= 0) return { success: false, error: 'Invalid amount' };
    if (!customerInfo?.name || !customerInfo?.email || !customerInfo?.phone) return { success: false, error: 'Incomplete customer info' };
    console.log(`[PayMongo] createGCashPayment mode=${this.mode} real=${this.isRealMode()} amount=${amount}`);

    // In TEST mode, require keys; do not silently fall back to mock
    if (this.mode === 'test' && !this.isRealMode()) {
      console.warn('[PayMongo] TEST mode but missing API keys. Set PAYMONGO_SECRET_KEY and PAYMONGO_PUBLIC_KEY.');
      return { success: false, error: 'PayMongo test keys not configured. Set PAYMONGO_SECRET_KEY/PAYMONGO_PUBLIC_KEY and restart server.' };
    }

    // MOCK mode (no external calls)
    if (!this.isRealMode()) {
      console.log('[PayMongo] Using MOCK flow (no external API calls)');
      return this._createMockGCashPayment(amount, description, customerInfo, bookingId);
    }

    try {
      // For sandbox/test: allow choosing between Checkout Sessions and Payment Intents (default: Payment Intents)
      if (this.mode === 'test' && this.useCheckoutSessions) {
        console.log('[PayMongo] Using Checkout Sessions (sandbox/test)');
        const session = await this._createCheckoutSession(amount, description, customerInfo);
        return {
          success: true,
          data: {
            paymentIntentId: session.id, // we reuse this name for polling
            paymentMethodId: '',
            redirectUrl: session.attributes?.checkout_url || session.attributes?.checkout_url_with_content_security_policy || '',
            clientKey: '',
            status: this._checkoutSessionsStatus.get(session.id) || 'processing',
            amount: Math.round(amount * 100),
            currency: 'PHP'
          }
        };
      }

      console.log('[PayMongo] Using REAL PayMongo API (payment_intents)');
      const intent = await this._createPaymentIntent(amount, description, {
        customer_name: customerInfo.name,
        customer_email: customerInfo.email,
        customer_phone: customerInfo.phone,
        booking_id: bookingId || ''
      });
  const paymentMethod = await this._createGCashPaymentMethod(customerInfo);
  // Build a return URL so WebView can hit our success page after authorization
  const baseHost = process.env.PAYMONGO_CHECKOUT_CALLBACK_BASE || 'http://10.0.2.2:5000';
  const returnUrl = `${baseHost}/api/payments/gcash/checkout/success?pi_id=${encodeURIComponent(intent.id)}`;
  const attached = await this._attachPaymentMethod(intent.id, paymentMethod.id, returnUrl);
      const attrs = attached.attributes;
      return {
        success: true,
        data: {
          paymentIntentId: intent.id,
          paymentMethodId: paymentMethod.id,
            redirectUrl: attrs.next_action?.redirect?.url || '',
          clientKey: attrs.client_key,
          status: attrs.status,
          amount: Math.round(amount * 100),
          currency: 'PHP'
        }
      };
    } catch (error) {
      console.error('PayMongo real createGCashPayment error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.errors?.[0]?.detail || 'Failed to create GCash payment' };
    }
  }

  async checkPaymentStatus(paymentIntentId) {
    if (!paymentIntentId) return { success: false, error: 'Payment intent id required' };
    // MOCK mode simply checks mock map
    if (!this.isRealMode()) {
      return this._mockStatus(paymentIntentId);
    }
    // Sandbox/test: depending on mode, fetch checkout session or payment intent
    if (this.mode === 'test') {
      if (!this.isRealMode()) {
        return { success: false, error: 'PayMongo test keys not configured' };
      }
      if (this.useCheckoutSessions) {
        try {
          const session = await this._getCheckoutSession(paymentIntentId);
          const attrs = session?.attributes || {};
          let status = 'processing';
          if (attrs.status === 'paid') status = 'succeeded';
          else if (attrs.status === 'expired' || attrs.status === 'cancelled' || attrs.status === 'canceled') status = 'canceled';
          const piStatus = attrs.payment_intent?.attributes?.status || attrs.payment_intent_status;
          if (piStatus === 'succeeded') status = 'succeeded';
          else if (piStatus === 'canceled' || piStatus === 'cancelled') status = 'canceled';
          if (status === 'processing') {
            status = this._checkoutSessionsStatus.get(paymentIntentId) || 'processing';
          }
          return { success: true, status, data: session };
        } catch (err) {
          console.warn('[PayMongo] Failed to fetch checkout session from API, falling back to local status:', err.response?.data || err.message);
          const status = this._checkoutSessionsStatus.get(paymentIntentId) || 'processing';
          return { success: true, status, data: { id: paymentIntentId, type: 'checkout_session' } };
        }
      } else {
        try {
          const intent = await this._getPaymentIntent(paymentIntentId);
          return { success: true, status: intent.attributes.status, data: intent };
        } catch (err) {
          console.error('[PayMongo] Error fetching payment intent (test):', err.response?.data || err.message);
          return { success: false, error: 'Failed to check payment status' };
        }
      }
    }
    try {
      const intent = await this._getPaymentIntent(paymentIntentId);
      return { success: true, status: intent.attributes.status, data: intent };
    } catch (error) {
      console.error('PayMongo real checkPaymentStatus error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.errors?.[0]?.detail || 'Failed to check payment status' };
    }
  }

  // Mark checkout session status (called by controller on success/cancel redirect)
  markCheckoutSession(sessionId, status) {
    if (!sessionId) return false;
    const current = this._checkoutSessionsStatus.get(sessionId) || 'processing';
    if (status === 'succeeded' || status === 'canceled') {
      this._checkoutSessionsStatus.set(sessionId, status);
      console.log(`[PayMongo] Checkout session ${sessionId} marked as ${status} (prev=${current})`);
      return true;
    }
    return false;
  }

  getMode() {
    return {
      mode: this.mode,
      real: this.isRealMode(),
      hasKeys: !!(this.secretKey && this.publicKey)
    };
  }
}

module.exports = new PayMongoService();