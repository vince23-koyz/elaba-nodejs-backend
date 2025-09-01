// routes/shopRoutes.js
const express = require('express');
const {
  createShop,
  getShops,
  getShopById,
  updateShop,
  deleteShop,
  getShopByAdmin
} = require('../controllers/shopController');

const router = express.Router();

router.post('/', createShop);
router.get('/', getShops);
router.get('/:id', getShopById);
router.get('/admin/:admin_id', getShopByAdmin); // <-- fetch shop by admin_id
router.put('/:id', updateShop);
router.delete('/:id', deleteShop);

module.exports = router;