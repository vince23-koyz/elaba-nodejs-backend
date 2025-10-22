const axios = require('axios');

async function testNewIP() {
  console.log('🔍 Testing new IP address for forgot password...');
  
  const testPhone = '+639897';
  console.log(`📱 Testing with: "${testPhone}"`);

  try {
    const response = await axios.post(
      'http://192.168.1.15:5000/api/admin/forgot-password',
      { phone_number: testPhone },
      { 
        headers: { 'Content-Type': 'application/json' },
        timeout: 5000
      }
    );

    console.log('✅ SUCCESS! Admin found:', response.data);
    
    if (response.data.success) {
      console.log(`🎉 Found admin: ${response.data.admin_name}`);
      console.log(`🔐 OTP: ${response.data.otp}`);
    }

  } catch (error) {
    if (error.response) {
      console.log('❌ API Error:', error.response.status, error.response.data);
    } else {
      console.log('❌ Network Error:', error.message);
    }
  }
}

testNewIP();