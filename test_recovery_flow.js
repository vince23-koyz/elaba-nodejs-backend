// Test the improved phone matching with actual API calls
const axios = require('axios');

const API_BASE_URL = 'http://192.168.1.15:5000/api';

async function testPasswordRecoveryFlow() {
  try {
    console.log('🧪 Testing Password Recovery Flow...\n');
    
    // Test data - using a phone number from the database
    const testPhoneNumbers = [
      '09897',      // Exact match from DB
      '+639897',    // Formatted version
      '9897',       // Without 0 prefix
      '639897',     // With country code, no +
    ];
    
    for (const testPhone of testPhoneNumbers) {
      console.log(`\n📱 Testing with phone: "${testPhone}"`);
      
      try {
        // Step 1: Request OTP
        console.log('  Step 1: Requesting OTP...');
        const forgotResponse = await axios.post(`${API_BASE_URL}/admin/forgot-password`, {
          phone_number: testPhone
        }, { timeout: 5000 });
        
        if (forgotResponse.data.success) {
          console.log(`  ✅ OTP request successful for admin: ${forgotResponse.data.admin_name}`);
          console.log(`  🔐 OTP: ${forgotResponse.data.otp}`);
          
          // Step 2: Verify OTP
          console.log('  Step 2: Verifying OTP...');
          const verifyResponse = await axios.post(`${API_BASE_URL}/admin/verify-otp`, {
            phone_number: testPhone,
            otp: forgotResponse.data.otp
          }, { timeout: 5000 });
          
          if (verifyResponse.data.success) {
            console.log(`  ✅ OTP verification successful for: ${verifyResponse.data.admin_name}`);
            
            // Step 3: Reset Password
            console.log('  Step 3: Resetting password...');
            const resetResponse = await axios.post(`${API_BASE_URL}/admin/reset-password`, {
              phone_number: testPhone,
              new_password: 'newpassword123'
            }, { timeout: 5000 });
            
            if (resetResponse.data.success) {
              console.log(`  ✅ Password reset successful: ${resetResponse.data.message}`);
              console.log(`  🎉 FULL FLOW COMPLETED SUCCESSFULLY for "${testPhone}"`);
            } else {
              console.log(`  ❌ Password reset failed: ${resetResponse.data.message}`);
            }
          } else {
            console.log(`  ❌ OTP verification failed: ${verifyResponse.data.message}`);
          }
        } else {
          console.log(`  ❌ OTP request failed: ${forgotResponse.data.message}`);
        }
        
      } catch (error) {
        if (error.response) {
          console.log(`  ❌ API Error: ${error.response.status} - ${error.response.data.message}`);
        } else if (error.code === 'ECONNREFUSED') {
          console.log(`  ❌ Connection Error: Backend server not running`);
          break;
        } else {
          console.log(`  ❌ Network Error: ${error.message}`);
        }
      }
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

testPasswordRecoveryFlow();