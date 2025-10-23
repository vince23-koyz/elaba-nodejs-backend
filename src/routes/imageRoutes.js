const express = require('express');
const router = express.Router();
const upload = require('../config/multer');

router.post('/upload', upload.single('image'), (req, res) => {
  try {
    res.json({ url: req.file.path }); // Cloudinary URL ng uploaded image
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Image upload failed' });
  }
});

module.exports = router;
