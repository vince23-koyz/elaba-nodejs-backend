// routes/shopRoutes.js
const express = require('express');
const upload = require('../config/multer');
const {
  createShop,
  getShops,
  getShopById,
  updateShop,
  deleteShop,
  getShopByAdmin
} = require('../controllers/shopController');

const router = express.Router();

router.post('/', upload.single('shopImage'), createShop);
router.get('/', getShops);
router.get('/:id', getShopById);
router.get('/admin/:admin_id', getShopByAdmin);
router.put('/:id', upload.single('shopImage'), updateShop);
router.delete('/:id', deleteShop);

module.exports = router;