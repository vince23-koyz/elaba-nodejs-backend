// routes/shopRoutes.js
const express = require('express');
const upload = require('../config/multer');
const { documentUpload } = upload;
const {
  createShop,
  getShops,
  getShopById,
  updateShop,
  deleteShop,
  getShopByAdmin,
  rejectShop,
  uploadShopDocuments,
  getShopDocuments,
  reviewShopDocument
} = require('../controllers/shopController');

const router = express.Router();

function handleDocumentUploadError(err, req, res, next) {
  if (!err) return next();
  if (err.name === 'MulterError') {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'Each verification document must be 5 MB or smaller.'
      : 'Only PDF, JPG, and PNG verification documents are accepted.';
    return res.status(400).json({ success: false, message });
  }
  console.error('Document upload error:', err);
  return res.status(500).json({
    success: false,
    message: 'The verification document could not be saved. Please try again.',
  });
}

router.post('/', upload.single('shopImage'), createShop);
router.post('/:id/documents', documentUpload.fields([
  { name: 'business_permit', maxCount: 1 },
  { name: 'dti_registration', maxCount: 1 },
  { name: 'sec_registration', maxCount: 1 },
]), handleDocumentUploadError, uploadShopDocuments);
router.get('/:id/documents', getShopDocuments);
router.patch('/documents/:id/review', reviewShopDocument);
router.post('/:id/reject', rejectShop);
router.get('/', getShops);
router.get('/:id', getShopById);
router.get('/admin/:admin_id', getShopByAdmin);
router.put('/:id', upload.single('shopImage'), updateShop);
router.delete('/:id', deleteShop);

module.exports = router;