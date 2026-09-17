const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const bcrypt = require('bcrypt');
const db = require('./src/config/db');

const superAdmins = [
  {
    username: 'vinsmok24',
    email: 'vipanton@my.cspc.edu.ph',
    password: 'SuperAd_elaba2026'
  },
  {
    username: 'zimmry321',
    email: 'zigarin@my.cspc.edu.ph',
    password: 'zigarin123'
  },
  {
    username: 'chopss345',
    email: 'member3@my.cspc.edu.ph',
    password: 'niel222'
  },
  {
    username: 'itExpert26',
    email: 'eLaba4dmin@gmail.com',
    password: 'admin4password'
  }
];

async function seedSuperAdmins() {
  try {
    for (const admin of superAdmins) {
      const [existing] = await db.query(
        `SELECT super_admin_id FROM super_admin
         WHERE username = ? OR email = ?
         LIMIT 1`,
        [admin.username, admin.email]
      );

      if (existing.length > 0) {
        console.log(`Skipped (already exists): ${admin.username}`);
        continue;
      }

      const hashedPassword = await bcrypt.hash(admin.password, 10);

      await db.query(
        `INSERT INTO super_admin (username, password, email)
         VALUES (?, ?, ?)`,
        [admin.username, hashedPassword, admin.email]
      );

      console.log(`Created: ${admin.username}`);
    }

    console.log('All Super Admin accounts created.');
    process.exit(0);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      console.error('Error: May existing super admin account na kapareho ang username o email.');
    } else {
      console.error('Error:', error.message);
    }
    process.exit(1);
  }
}

seedSuperAdmins();