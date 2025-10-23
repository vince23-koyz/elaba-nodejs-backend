// config/multer.js
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

// Detect if Cloudinary is configured
const hasCloudinary = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
);

// Configure Cloudinary regardless; storage use depends on hasCloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

let storage;
if (hasCloudinary) {
  storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
      folder: 'elaba-images',
      // Allow common mobile formats. jpeg is separate from jpg; heic/heif from iOS devices.
      allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'],
      resource_type: 'image',
    },
  });
  console.log('🖼️  Using Cloudinary storage for uploads');
} else {
  // Fallback to local disk storage if Cloudinary not configured (useful for dev or temporary prod fallback)
  storage = multer.diskStorage({
    destination: function (req, file, cb) {
      // Choose subfolder by fieldname
      let sub = 'misc';
      if (file.fieldname === 'profilePicture') sub = 'profile';
      if (file.fieldname === 'shopImage') sub = 'shop-images';
      const dest = path.join(__dirname, '../../uploads', sub);
      try { fs.mkdirSync(dest, { recursive: true }); } catch {}
      cb(null, dest);
    },
    filename: function (req, file, cb) {
      const ext = path.extname(file.originalname || '.jpg');
      const base = file.fieldname === 'shopImage' ? 'shop' : 'profile';
      const name = `${base}_${Date.now()}${ext}`;
      cb(null, name);
    }
  });
  console.log('💾 Using local disk storage for uploads (Cloudinary env not set)');
}

const upload = multer({ storage });

module.exports = upload;
