// Simple test to fetch dashboard data using fetch (node 18+)
async function testDashboardEndpoints() {
  const baseUrl = 'http://localhost:5000/api';
  
  console.log('🔍 Testing Dashboard Endpoints...\n');
  
  // Test endpoints
  const endpoints = [
    { name: 'Test Endpoint', url: `${baseUrl}/test` },
    { name: 'Dashboard Stats', url: `${baseUrl}/superadmin/dashboard/stats` },
    { name: 'All Customers', url: `${baseUrl}/customers` },
    { name: 'All Shops', url: `${baseUrl}/shop` }
  ];
  
  for (const endpoint of endpoints) {
    try {
      console.log(`📡 Testing: ${endpoint.name} - ${endpoint.url}`);
      
      const response = await fetch(endpoint.url);
      
      if (response.ok) {
        const data = await response.json();
        console.log(`✅ ${endpoint.name}: SUCCESS`);
        
        if (endpoint.name === 'Dashboard Stats') {
          console.log(`   📊 Total Customers: ${data.totalCustomers || 0}`);
          console.log(`   🏪 Total Shops: ${data.totalShops || 0}`);
          console.log(`   📈 Total Bookings: ${data.totalBookings || 0}`);
          console.log(`   💰 Total Revenue: ₱${data.totalRevenue || 0}`);
        } else if (endpoint.name === 'All Customers') {
          console.log(`   👥 Found ${Array.isArray(data) ? data.length : 'unknown'} customers`);
        } else if (endpoint.name === 'All Shops') {
          console.log(`   🏪 Found ${Array.isArray(data) ? data.length : 'unknown'} shops`);
        } else {
          console.log(`   📄 Response:`, JSON.stringify(data, null, 2));
        }
      } else {
        console.log(`❌ ${endpoint.name}: FAILED - Status ${response.status}`);
        const errorText = await response.text();
        console.log(`   Error: ${errorText}`);
      }
    } catch (error) {
      console.log(`❌ ${endpoint.name}: ERROR - ${error.message}`);
    }
    console.log(''); // Empty line for readability
  }
}

// Check if server is running first
async function checkServer() {
  try {
    const response = await fetch('http://localhost:5000/api/test');
    if (response.ok) {
      console.log('✅ Backend server is running!\n');
      return true;
    }
  } catch (error) {
    console.log('❌ Backend server is not running!');
    console.log('💡 Please start the server first with: node src/app.js');
    console.log('   Or use the test server: node test_dashboard.js\n');
    return false;
  }
}

// Main function
async function main() {
  console.log('🚀 eLaba Backend Endpoint Test\n');
  
  const serverRunning = await checkServer();
  if (serverRunning) {
    await testDashboardEndpoints();
  }
  
  console.log('🏁 Test completed!');
}

// Run the test
main().catch(console.error);