const axios = require('axios');

async function testPhoneNumber() {
  try {
    console.log('🔍 Testing phone number validation...');
    
    const testPhone = '+639897'; // Sample phone from database
    console.log(`📱 Testing with: "${testPhone}"`);

    // Test both localhost and emulator IP
    const urls = [
      'http://localhost:5000/api/admin/forgot-password',
      'http://10.0.2.2:5000/api/admin/forgot-password'
    ];

    for (const url of urls) {
      console.log(`\n🌐 Testing: ${url}`);
      try {
        const response = await axios.post(
          url,
          { phone_number: testPhone },
          { 
            headers: { 'Content-Type': 'application/json' },
            timeout: 5000
          }
        );
        console.log('✅ Success:', response.data);
      } catch (error) {
        if (error.response) {
          console.log('❌ Error Response:', error.response.status, error.response.data);
        } else {
          console.log('❌ Network Error:', error.message);
        }
      }
    }

    console.log('✅ Success:', response.data);

  } catch (error) {
    if (error.response) {
      console.log('❌ Error Response:', error.response.status, error.response.data);
    } else {
      console.log('❌ Network Error:', error.message);
    }
  }
}

testPhoneNumber();