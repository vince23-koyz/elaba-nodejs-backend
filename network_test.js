const axios = require('axios');
const { exec } = require('child_process');

async function testNetworkConnectivity() {
  console.log('🔍 Testing network connectivity...');
  
  // Test 1: Check if server is bound to correct interfaces
  console.log('\n1️⃣ Checking server binding...');
  exec('netstat -ano | findstr :5000', (error, stdout, stderr) => {
    if (error) {
      console.log('❌ Error checking ports:', error.message);
      return;
    }
    console.log('📊 Port 5000 bindings:');
    console.log(stdout);
  });

  // Test 2: Test localhost
  console.log('\n2️⃣ Testing localhost access...');
  try {
    const response = await axios.get('http://localhost:5000/api/admin', { timeout: 3000 });
    console.log('✅ Localhost accessible');
  } catch (error) {
    console.log('❌ Localhost error:', error.message);
  }

  // Test 3: Test emulator IP
  console.log('\n3️⃣ Testing emulator IP access...');
  try {
    const response = await axios.get('http://10.0.2.2:5000/api/admin', { timeout: 3000 });
    console.log('✅ Emulator IP accessible');
  } catch (error) {
    console.log('❌ Emulator IP error:', error.message);
  }

  // Test 4: Check computer's IP
  console.log('\n4️⃣ Getting computer IP addresses...');
  exec('ipconfig | findstr IPv4', (error, stdout, stderr) => {
    if (error) {
      console.log('❌ Error getting IP:', error.message);
      return;
    }
    console.log('💻 Computer IP addresses:');
    console.log(stdout);
  });

  // Test 5: Test phone number API specifically
  console.log('\n5️⃣ Testing forgot password API...');
  const testPhone = '+639897';
  
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
          timeout: 3000
        }
      );
      console.log('✅ Success:', response.data.success ? 'Admin found!' : 'Failed');
    } catch (error) {
      if (error.response) {
        console.log('❌ API Error:', error.response.status, error.response.data?.message || 'No message');
      } else {
        console.log('❌ Network Error:', error.message);
      }
    }
  }
}

testNetworkConnectivity();