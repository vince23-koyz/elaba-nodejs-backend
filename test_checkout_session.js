/* Quick test to create a GCash Checkout Session via backend and print the checkout URL */
const axios = require('axios');

async function run() {
  const base = process.env.TEST_BACKEND_BASE || 'http://localhost:5000';
  const url = `${base}/api/payments/gcash/create`;
  try {
    const res = await axios.post(url, {
      amount: 10.0,
      description: 'eLaba Test Checkout Session',
      customerInfo: {
        name: 'Test User',
        email: 'test@example.com',
        phone: '09123456789'
      }
    });
    console.log('Response:', res.data);
    const redirectUrl = res?.data?.data?.redirectUrl;
    if (redirectUrl) {
      console.log('\nOpen this checkout URL in a WebView or browser:');
      console.log(redirectUrl);
    } else {
      console.log('\nNo redirectUrl returned. If PAYMONGO_MODE is mock, switch to test and set API keys.');
    }
  } catch (e) {
    console.error('Error:', e.response?.data || e.message);
  }
}

run();
// Quick test: create a GCash checkout session via backend
// Requires PAYMONGO_SECRET_KEY and PAYMONGO_MODE=test in eLaba-backend/.env

const axios = require('axios');

(async () => {
  try {
    const base = process.env.TEST_BASE || 'http://localhost:5000/api';
    const res = await axios.post(`${base}/payments/gcash/create`, {
      amount: 12.34,
      description: 'eLaba Test Checkout',
      customerInfo: {
        name: 'Test User',
        email: 'test@example.com',
        phone: '09123456789'
      }
    }, { timeout: 15000 });

    console.log('Create response:', res.data);
    if (res.data?.data?.redirectUrl) {
      console.log('\nOpen this in a browser/WebView to test payment:');
      console.log(res.data.data.redirectUrl);
    } else {
      console.log('No redirect URL. Mode may be mock without keys.');
    }
  } catch (e) {
    console.error('Test failed:', e.response?.data || e.message);
  }
})();
