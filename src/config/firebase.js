// eLaba-backend/src/config/firebase.js
const admin = require("firebase-admin");
const serviceAccount = require("../../elaba-app-firebase-adminsdk-fbsvc-5bfbc77238.json");

// Initialize Firebase Admin SDK

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

module.exports = admin;
