// config/multer.js
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const DOCUMENT_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
]);

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
const documentStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dest = path.join(__dirname, '../../uploads', 'shop-documents');
    try { fs.mkdirSync(dest, { recursive: true }); } catch {}
    cb(null, dest);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname || '') || (file.mimetype === 'application/pdf' ? '.pdf' : '.jpg');
    cb(null, `${file.fieldname}_${Date.now()}${ext.toLowerCase()}`);
  },
});

if (hasCloudinary) {
  storage = new CloudinaryStorage({
    cloudinary: cloudinary,
    params: {
      folder: 'elaba-images',
      // Keep image uploads working while allowing verification PDFs.
      allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'pdf'],
      resource_type: 'auto',
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
      if (['business_permit', 'dti_registration', 'sec_registration'].includes(file.fieldname)) sub = 'shop-documents';
      const dest = path.join(__dirname, '../../uploads', sub);
      try { fs.mkdirSync(dest, { recursive: true }); } catch {}
      cb(null, dest);
    },
    filename: function (req, file, cb) {
      const ext = path.extname(file.originalname || '.jpg');
      const base = file.fieldname === 'shopImage'
        ? 'shop'
        : ['business_permit', 'dti_registration', 'sec_registration'].includes(file.fieldname)
          ? file.fieldname
          : 'profile';
      const name = `${base}_${Date.now()}${ext}`;
      cb(null, name);
    }
  });
  console.log('💾 Using local disk storage for uploads (Cloudinary env not set)');
}

const upload = multer({ storage });

const documentUpload = multer({
  storage: documentStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!DOCUMENT_MIME_TYPES.has(file.mimetype)) {
      return cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', file.fieldname));
    }
    cb(null, true);
  },
});

module.exports = upload;
module.exports.documentUpload = documentUpload;
