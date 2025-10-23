// config/multer.js
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'elaba-images',
    // Allow common mobile formats. jpeg is separate from jpg; heic/heif from iOS devices.
    allowed_formats: ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'],
    // Let Cloudinary handle images from various sources automatically
    resource_type: 'image', // or 'auto' but 'image' is appropriate here
  },
});

const upload = multer({ storage });

module.exports = upload;
