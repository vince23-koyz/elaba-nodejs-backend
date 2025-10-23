const express = require('express');
const router = express.Router();
const upload = require('../config/multer');
const cloudinary = require('cloudinary').v2;

router.post('/upload', upload.single('image'), (req, res) => {
  try {
    res.json({ url: req.file.path });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Image upload failed' });
  }
});

router.get('/status', (req, res) => {
  const cfg = cloudinary.config();
  res.json({
    cloud_name_set: !!cfg.cloud_name,
    api_key_set: !!cfg.api_key,
    api_secret_set: !!cfg.api_secret,
  });
});

module.exports = router;