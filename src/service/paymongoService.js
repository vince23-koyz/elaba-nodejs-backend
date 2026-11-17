const axios = require('axios');
const { v4: uuid } = require('uuid');

function normalizeQrPhStatus(status) {
  const normalized = String(status || '').toLowerCase();
  if (['paid', 'succeeded'].includes(normalized)) return 'paid';
  if (['failed', 'canceled', 'cancelled', 'expired', 'awaiting_payment_method'].includes(normalized)) {
    return normalized === 'expired' ? 'expired' : 'failed';
  }
  return 'pending';
}

function toTimestampMilliseconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1000000000000 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const numericValue = Number(value);
    if (Number.isFinite(numericValue) && numericValue > 0) {
      return numericValue < 1000000000000 ? numericValue * 1000 : numericValue;
    }
    const parsedValue = Date.parse(value);
    return Number.isNaN(parsedValue) ? null : parsedValue;
  }
  return null;
}

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
    return this.mode !== 'mock' && Boolean(this.secretKey && this.publicKey);
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

  _getCheckoutRedirectUrl(result) {
    const configuredUrl = result === 'success'
      ? process.env.PAYMONGO_SUCCESS_URL
      : process.env.PAYMONGO_CANCEL_URL;
    if (configuredUrl) {
      let parsedUrl;
      try {
        parsedUrl = new URL(configuredUrl);
      } catch {
        throw new Error(`PAYMONGO_${result.toUpperCase()}_URL must be a valid absolute URL`);
      }
      if (!['example.com', 'www.example.com'].includes(parsedUrl.hostname.toLowerCase())) {
        return configuredUrl;
      }
    }

    const callbackBase = (
      process.env.PAYMONGO_CHECKOUT_CALLBACK_BASE ||
      process.env.PUBLIC_BASE_URL ||
      `http://10.0.2.2:${process.env.PORT || 5000}`
    ).replace(/\/+$/, '');
    return `${callbackBase}/api/payments/gcash/checkout/${result}`;
  }

  // Test/Sandbox: Checkout Sessions (preferred for GCash in sandbox)
  async _createCheckoutSession(amount, description, customerInfo) {
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
          billing: {
            name: customerInfo?.name || undefined,
            email: customerInfo?.email || undefined,
            phone: customerInfo?.phone || undefined
          },
          // Use uppercase, simple descriptor to satisfy provider rules
          statement_descriptor: 'ELABA',
          success_url: this._getCheckoutRedirectUrl('success'),
          cancel_url: this._getCheckoutRedirectUrl('cancel')
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

  async _getPaymentForIntent(paymentIntentId) {
    const response = await this.secretClient.get('/payments', { params: { limit: 100 } });
    const payments = response.data?.data;
    return Array.isArray(payments)
      ? payments.find((payment) => payment?.attributes?.payment_intent_id === paymentIntentId) || null
      : null;
  }

  _extractPayMongoPaymentId(resource) {
    const attributes = resource?.attributes || {};
    const payments = attributes.payments || resource?.payments || [];
    const payment = Array.isArray(payments) ? payments[0] : payments;
    const paymentIntent = attributes.payment_intent;
    const intentPayments = paymentIntent?.attributes?.payments || [];
    const intentPayment = Array.isArray(intentPayments) ? intentPayments[0] : intentPayments;
    return payment?.id || payment?.data?.id || intentPayment?.id || intentPayment?.data?.id ||
      (typeof paymentIntent === 'string' ? null : paymentIntent?.id || paymentIntent?.data?.id) || null;
  }

  async _resolveCheckoutPaymentId(session) {
    const directPaymentId = this._extractPayMongoPaymentId(session);
    if (directPaymentId) {
      console.log(`[PayMongo] Resolved checkout payment ID ${directPaymentId} from checkout session`);
      return directPaymentId;
    }

    const paymentIntent = session?.attributes?.payment_intent;
    const paymentIntentId = typeof paymentIntent === 'string'
      ? paymentIntent
      : paymentIntent?.id || paymentIntent?.data?.id;
    if (!paymentIntentId) return null;

    try {
      const intent = await this._getPaymentIntent(paymentIntentId);
      const embeddedPaymentId = this._extractPayMongoPaymentId(intent);
      if (embeddedPaymentId) {
        console.log(`[PayMongo] Resolved checkout payment ID ${embeddedPaymentId} from payment intent ${paymentIntentId}`);
        return embeddedPaymentId;
      }
      const payment = await this._getPaymentForIntent(paymentIntentId);
      const paymentId = payment?.id || null;
      console.log(`[PayMongo] Payment collection lookup for ${paymentIntentId}: ${paymentId || 'not found'}`);
      return paymentId;
    } catch (error) {
      console.warn('[PayMongo] Unable to resolve checkout payment ID:', error.response?.data || error.message);
      return null;
    }
  }

  async resolvePaymentId(referenceId) {
    if (!referenceId || !this.isRealMode()) return null;
    if (String(referenceId).startsWith('pay_')) return referenceId;

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        const paymentId = String(referenceId).startsWith('cs_')
          ? await this._resolveCheckoutPaymentId(await this._getCheckoutSession(referenceId))
          : String(referenceId).startsWith('pi_')
            ? await this._resolveCheckoutPaymentId({ attributes: { payment_intent: referenceId } })
            : null;
        if (paymentId) return paymentId;
      } catch (error) {
        console.warn(`[PayMongo] Payment ID resolution attempt ${attempt} failed:`, error.response?.data || error.message);
      }
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    console.warn(`[PayMongo] No pay_ ID found for reference ${referenceId} after 5 attempts`);
    return null;
  }

  _formatQrPhPayment(intent, expirySeconds, fallbackCreatedAt) {
    const attributes = intent?.attributes || {};
    const createdAt = fallbackCreatedAt || toTimestampMilliseconds(attributes.created_at) || null;
    const qrImage = attributes.next_action?.code?.image_url || null;
    const status = normalizeQrPhStatus(attributes.status);

    return {
      paymentIntentId: intent?.id || null,
      paymongoPaymentId: this._extractPayMongoPaymentId(intent),
      status,
      providerStatus: attributes.status || null,
      qrImage,
      amount: Number.isFinite(Number(attributes.amount)) ? Number(attributes.amount) / 100 : null,
      currency: attributes.currency || 'PHP',
      expirySeconds,
      expiresAt: createdAt
        ? new Date(createdAt + expirySeconds * 1000).toISOString()
        : null,
    };
  }

  async createQrPhPayment(amount, description, metadata = {}, expirySeconds = 1800) {
    const amountInPesos = Number(amount);
    const amountInCentavos = Math.round(amountInPesos * 100);
    if (!Number.isSafeInteger(amountInCentavos) || amountInCentavos < 100) {
      return { success: false, error: 'QR Ph payment amount must be at least PHP 1.00' };
    }
    if (!Number.isInteger(expirySeconds) || expirySeconds < 60 || expirySeconds > 9000) {
      return { success: false, error: 'QR Ph expiry must be between 60 and 9000 seconds' };
    }
    if (!this.isRealMode()) {
      return {
        success: false,
        error: this.mode === 'test'
          ? 'PayMongo test keys are not configured'
          : this.mode === 'mock'
            ? 'QR Ph is not available in mock mode'
            : 'PayMongo API keys are not configured',
      };
    }

    try {
      const intentResponse = await this.secretClient.post('/payment_intents', {
        data: {
          attributes: {
            amount: amountInCentavos,
            currency: 'PHP',
            payment_method_allowed: ['qrph'],
            description: description || 'eLaba Pickup and Delivery Payment',
            statement_descriptor: 'ELABA',
            metadata,
          },
        },
      }, { timeout: 20000 });
      const intent = intentResponse.data?.data;
      const clientKey = intent?.attributes?.client_key;
      if (!intent?.id || !clientKey) {
        return { success: false, error: 'PayMongo returned an incomplete QR Ph Payment Intent' };
      }

      const qrCreatedAt = Date.now();
      const paymentMethodResponse = await this.publicClient.post('/payment_methods', {
        data: {
          attributes: {
            type: 'qrph',
            expiry_seconds: expirySeconds,
          },
        },
      }, { timeout: 20000 });
      const paymentMethod = paymentMethodResponse.data?.data;
      if (!paymentMethod?.id) {
        return { success: false, error: 'PayMongo did not return a QR Ph Payment Method' };
      }

      const attachResponse = await this.publicClient.post(
        `/payment_intents/${intent.id}/attach`,
        {
          data: {
            attributes: {
              payment_method: paymentMethod.id,
              client_key: clientKey,
            },
          },
        },
        { timeout: 20000 },
      );
      const attachedIntent = attachResponse.data?.data;
      const data = this._formatQrPhPayment(attachedIntent, expirySeconds, qrCreatedAt);
      if (!data.paymentIntentId || !data.qrImage) {
        return { success: false, error: 'PayMongo did not return a QR image for this Payment Intent' };
      }
      return { success: true, data };
    } catch (error) {
      console.error('PayMongo QR Ph creation error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.errors?.[0]?.detail || 'Failed to create QR Ph payment',
      };
    }
  }

  async getQrPhPayment(referenceId, expirySeconds = 1800) {
    if (!referenceId || !this.isRealMode()) {
      return { success: false, error: 'PayMongo QR Ph payment reference is unavailable' };
    }

    try {
      let intent;
      let providerStatus = null;
      if (/^pi_[A-Za-z0-9_]+$/.test(String(referenceId))) {
        intent = await this._getPaymentIntent(referenceId);
      } else if (/^pay_[A-Za-z0-9_]+$/.test(String(referenceId))) {
        const response = await this.secretClient.get(`/payments/${referenceId}`, { timeout: 15000 });
        const payment = response.data?.data;
        if (!payment?.id) {
          return { success: false, error: 'PayMongo returned an incomplete QR Ph payment' };
        }
        const attributes = payment?.attributes || {};
        providerStatus = attributes.status || null;
        const paymentIntent = attributes.payment_intent_id || attributes.payment_intent;
        const paymentIntentId = typeof paymentIntent === 'string' ? paymentIntent : paymentIntent?.id;
        if (paymentIntentId && /^pi_[A-Za-z0-9_]+$/.test(paymentIntentId)) {
          intent = await this._getPaymentIntent(paymentIntentId);
        }
        if (!intent) {
          return {
            success: true,
            data: {
              paymentIntentId: paymentIntentId || null,
              paymongoPaymentId: payment.id,
              status: normalizeQrPhStatus(providerStatus),
              providerStatus,
              qrImage: null,
              amount: Number.isFinite(Number(attributes.amount)) ? Number(attributes.amount) / 100 : null,
              currency: attributes.currency || 'PHP',
              expirySeconds,
              expiresAt: null,
            },
          };
        }
      } else {
        return { success: false, error: 'Invalid PayMongo QR Ph payment reference' };
      }

      if (!intent?.id) {
        return { success: false, error: 'PayMongo returned an incomplete QR Ph Payment Intent' };
      }
      const data = this._formatQrPhPayment(intent, expirySeconds, null);
      if (providerStatus) {
        data.providerStatus = providerStatus;
        data.status = normalizeQrPhStatus(providerStatus);
      }
      if (/^pay_[A-Za-z0-9_]+$/.test(String(referenceId))) {
        data.paymongoPaymentId = referenceId;
      }
      return { success: true, data };
    } catch (error) {
      console.error('PayMongo QR Ph status error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.errors?.[0]?.detail || 'Unable to retrieve QR Ph payment status',
      };
    }
  }

  async cancelQrPhPayment(paymentIntentId) {
    if (!/^pi_[A-Za-z0-9_]+$/.test(String(paymentIntentId || ''))) {
      return { success: false, error: 'A valid QR Ph Payment Intent reference is required' };
    }
    if (!this.isRealMode()) {
      return {
        success: false,
        error: this.mode === 'mock'
          ? 'QR Ph cancellation is not available in mock mode'
          : 'PayMongo API keys are not configured',
      };
    }

    try {
      const response = await this.secretClient.post(
        `/payment_intents/${paymentIntentId}/cancel`,
        {},
        { timeout: 15000 },
      );
      const intent = response.data?.data;
      const providerStatus = String(intent?.attributes?.status || '').toLowerCase();
      if (!intent?.id || !['canceled', 'cancelled'].includes(providerStatus)) {
        return {
          success: false,
          error: 'PayMongo did not confirm that the QR Ph payment was cancelled',
        };
      }
      return { success: true, data: this._formatQrPhPayment(intent, 1800, null) };
    } catch (error) {
      console.error('PayMongo QR Ph cancellation error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.errors?.[0]?.detail || 'Unable to cancel the active QR Ph payment',
      };
    }
  }

  // ---------------- PUBLIC API ----------------
  async createGCashPayment(amount, description, customerInfo, bookingId) {
    if (!amount || amount <= 0) return { success: false, error: 'Invalid amount' };
    if (!customerInfo?.name || !customerInfo?.phone) return { success: false, error: 'Customer name and phone are required' };
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
            paymongoPaymentId: this._extractPayMongoPaymentId(session),
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
          paymongoPaymentId: this._extractPayMongoPaymentId(attached),
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

  async getGCashCheckout(referenceId) {
    if (!referenceId || !this.isRealMode()) return null;
    try {
      if (String(referenceId).startsWith('cs_')) {
        const session = await this._getCheckoutSession(referenceId);
        const attributes = session?.attributes || {};
        return {
          paymentIntentId: referenceId,
          redirectUrl: attributes.checkout_url || attributes.checkout_url_with_content_security_policy || null,
        };
      }
      if (String(referenceId).startsWith('pi_')) {
        const intent = await this._getPaymentIntent(referenceId);
        return {
          paymentIntentId: referenceId,
          redirectUrl: intent?.attributes?.next_action?.redirect?.url || null,
        };
      }
      return null;
    } catch (error) {
      console.error('[PayMongo] Failed to retrieve GCash checkout:', error.response?.data || error.message);
      return null;
    }
  }

  async checkPaymentStatus(paymentIntentId) {
    if (!paymentIntentId) return { success: false, error: 'Payment intent id required' };
    // MOCK mode simply checks mock map
    if (!this.isRealMode()) {
      return this._mockStatus(paymentIntentId);
    }
    if (String(paymentIntentId).startsWith('pay_')) {
      try {
        const response = await this.secretClient.get(`/payments/${paymentIntentId}`);
        const payment = response.data?.data;
        const paymentStatus = String(payment?.attributes?.status || '').toLowerCase();
        const status = ['paid', 'succeeded'].includes(paymentStatus)
          ? 'succeeded'
          : ['failed', 'canceled', 'cancelled'].includes(paymentStatus)
            ? 'canceled'
            : 'processing';
        return { success: true, status, paymongoPaymentId: payment.id, data: payment };
      } catch (error) {
        console.error('[PayMongo] Failed to fetch payment status:', error.response?.data || error.message);
        return {
          success: false,
          error: error.response?.data?.errors?.[0]?.detail || 'Failed to check payment status'
        };
      }
    }
    // Sandbox/test: depending on mode, fetch checkout session or payment intent
    if (this.mode === 'test') {
      if (!this.isRealMode()) {
        return { success: false, error: 'PayMongo test keys not configured' };
      }
      if (String(paymentIntentId).startsWith('cs_')) {
        try {
          const session = await this._getCheckoutSession(paymentIntentId);
          const attrs = session?.attributes || {};
          const sessionPayment = Array.isArray(attrs.payments) ? attrs.payments[0] : attrs.payments;
          const sessionPaymentStatus = sessionPayment?.attributes?.status;
          let status = 'processing';
          if (attrs.status === 'paid' || sessionPaymentStatus === 'paid') status = 'succeeded';
          else if (['expired', 'failed', 'cancelled', 'canceled'].includes(String(attrs.status || '').toLowerCase())) status = 'canceled';
          const piStatus = attrs.payment_intent?.attributes?.status || attrs.payment_intent_status;
          if (piStatus === 'succeeded') status = 'succeeded';
          else if (['failed', 'canceled', 'cancelled'].includes(String(piStatus || '').toLowerCase())) status = 'canceled';
          if (status === 'processing') {
            status = this._checkoutSessionsStatus.get(paymentIntentId) || 'processing';
          }
          const paymongoPaymentId = status === 'succeeded'
            ? await this._resolveCheckoutPaymentId(session)
            : null;
          console.log(`[PayMongo] Checkout session ${paymentIntentId}: status=${status} payment=${paymongoPaymentId || 'null'}`);
          return { success: true, status, paymongoPaymentId, data: session };
        } catch (err) {
          console.error('[PayMongo] Failed to fetch checkout session from API:', err.response?.data || err.message);
          return {
            success: false,
            error: err.response?.data?.errors?.[0]?.detail || 'Failed to check checkout session status'
          };
        }
      } else {
        try {
          const intent = await this._getPaymentIntent(paymentIntentId);
          const intentStatus = String(intent.attributes.status || '').toLowerCase();
          const status = ['failed', 'canceled', 'cancelled'].includes(intentStatus) ? 'canceled' : intentStatus;
          const paymongoPaymentId = status === 'succeeded'
            ? await this._resolveCheckoutPaymentId({ attributes: { payment_intent: paymentIntentId } })
            : null;
          return { success: true, status, paymongoPaymentId, data: intent };
        } catch (err) {
          console.error('[PayMongo] Error fetching payment intent (test):', err.response?.data || err.message);
          return { success: false, error: 'Failed to check payment status' };
        }
      }
    }
    try {
      const intent = await this._getPaymentIntent(paymentIntentId);
      const intentStatus = String(intent.attributes.status || '').toLowerCase();
      const status = ['failed', 'canceled', 'cancelled'].includes(intentStatus) ? 'canceled' : intentStatus;
      const paymongoPaymentId = status === 'succeeded'
        ? await this._resolveCheckoutPaymentId({ attributes: { payment_intent: paymentIntentId } })
        : null;
      return { success: true, status, paymongoPaymentId, data: intent };
    } catch (error) {
      console.error('PayMongo real checkPaymentStatus error:', error.response?.data || error.message);
      return { success: false, error: error.response?.data?.errors?.[0]?.detail || 'Failed to check payment status' };
    }
  }

  async createRefund({ paymentId, amount, reason = 'others', notes }) {
    if (this.mode !== 'test') {
      return { success: false, error: 'PayMongo refunds are enabled only in test mode' };
    }
    if (!this.isRealMode()) {
      return { success: false, error: 'PayMongo test keys not configured' };
    }
    if (!/^pay_[A-Za-z0-9_]+$/.test(String(paymentId || ''))) {
      return { success: false, error: 'A valid PayMongo payment ID is required' };
    }
    const amountInPesos = Number(amount);
    if (!Number.isFinite(amountInPesos) || amountInPesos <= 0) {
      return { success: false, error: 'Refund amount must be greater than zero' };
    }

    try {
      const response = await this.secretClient.post('/refunds', {
        data: {
          attributes: {
            amount: Math.round(amountInPesos * 100),
            payment_id: paymentId,
            reason,
            ...(notes ? { notes } : {})
          }
        }
      });
      const refund = response.data?.data;
      const status = refund?.attributes?.status;
      if (!refund?.id || !status) {
        return { success: false, error: 'Malformed PayMongo refund response' };
      }
      return { success: true, refund };
    } catch (error) {
      console.error('PayMongo refund error:', error.response?.data || error.message);
      return {
        success: false,
        error: error.response?.data?.errors?.[0]?.detail || 'PayMongo refund request failed'
      };
    }
  }

  async getRefund(refundId) {
    if (this.mode !== 'test') {
      return { success: false, error: 'PayMongo refunds are enabled only in test mode' };
    }
    if (!this.isRealMode()) return { success: false, error: 'PayMongo test keys not configured' };
    if (!/^[A-Za-z0-9_-]+$/.test(String(refundId || ''))) {
      return { success: false, error: 'A valid PayMongo refund ID is required' };
    }
    try {
      const response = await this.secretClient.get(`/refunds/${refundId}`);
      const refund = response.data?.data;
      if (!refund?.id || !refund?.attributes?.status) {
        return { success: false, error: 'Malformed PayMongo refund response' };
      }
      return { success: true, refund };
    } catch (error) {
      console.error('PayMongo refund status error:', error.response?.data || error.message);
      return { success: false, error: 'Unable to retrieve PayMongo refund status' };
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