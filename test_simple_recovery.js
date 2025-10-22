// Simple test for password recovery with correct API endpoint
const axios = require('axios');

const API_BASE_URL = 'http://10.0.2.2:5000/api'; // Same as frontend

async function testPasswordRecovery() {
  try {
    console.log('🧪 Testing Password Recovery with correct API endpoint...\n');
    
    // Test phone number from database
    const testPhone = '09897';
    
    console.log(`📱 Testing with phone: "${testPhone}"`);
    
    try {
      // Step 1: Request OTP
      console.log('  Step 1: Requesting OTP...');
      const response = await axios.post(`${API_BASE_URL}/admin/forgot-password`, {
        phone_number: testPhone
      }, { 
        headers: { 'Content-Type': 'application/json' },
        timeout: 5000 
      });
      
      if (response.data.success) {
        console.log(`  ✅ OTP request successful!`);
        console.log(`  👤 Admin: ${response.data.admin_name}`);
        console.log(`  🔐 OTP: ${response.data.otp}`);
        console.log(`  🎉 Ready for OTP verification step`);
      } else {
        console.log(`  ❌ OTP request failed: ${response.data.message}`);
      }
      
    } catch (error) {
      if (error.response) {
        console.log(`  ❌ API Error: ${error.response.status} - ${error.response.data?.message || 'Unknown error'}`);
      } else if (error.code === 'ECONNREFUSED') {
        console.log(`  ❌ Connection Error: Backend server not running on http://10.0.2.2:5000`);
        console.log(`  💡 Tip: Make sure backend is running with 'node src/app.js'`);
      } else {
        console.log(`  ❌ Network Error: ${error.message}`);
      }
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

testPasswordRecovery();