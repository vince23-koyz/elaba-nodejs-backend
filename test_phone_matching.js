// Test phone number matching logic
const db = require('./src/config/db');

async function testPhoneMatching() {
  try {
    console.log('🔍 Testing phone number matching...\n');
    
    // Get all admin phone numbers first
    const [allAdmins] = await db.query('SELECT admin_id, first_name, last_name, phone_number FROM admin');
    
    console.log('📋 All admin records in database:');
    allAdmins.forEach((admin, index) => {
      console.log(`${index + 1}. ID: ${admin.admin_id}, Name: ${admin.first_name} ${admin.last_name}, Phone: "${admin.phone_number}"`);
    });
    
    if (allAdmins.length === 0) {
      console.log('❌ No admin records found in database!');
      process.exit(1);
    }
    
    console.log('\n🧪 Testing phone number variations for first admin...');
    const firstAdmin = allAdmins[0];
    const originalPhone = firstAdmin.phone_number;
    
    console.log(`📱 Original phone in DB: "${originalPhone}"`);
    
    // Test different phone formats
    const testPhones = [
      originalPhone,
      originalPhone.replace(/\D/g, ''),
      '+63' + originalPhone.replace(/\D/g, '').substring(1),
      '09' + originalPhone.replace(/\D/g, '').substring(2),
      '9' + originalPhone.replace(/\D/g, '').substring(2),
    ];
    
    console.log('\n🔍 Testing phone variations:');
    for (const testPhone of testPhones) {
      try {
        const [results] = await db.query('SELECT admin_id, first_name, phone_number FROM admin WHERE phone_number = ?', [testPhone]);
        console.log(`"${testPhone}" → ${results.length > 0 ? '✅ FOUND' : '❌ NOT FOUND'}`);
      } catch (err) {
        console.log(`"${testPhone}" → ❌ ERROR: ${err.message}`);
      }
    }
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  }
}

testPhoneMatching();