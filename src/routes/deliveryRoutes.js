// routes/deliveryRoutes.js
const express = require('express');
const {
  createDelivery,
  getDeliveries,
  getDeliveryById,
  updateDelivery,
  updateDeliveryStatus,
  deleteDelivery
} = require('../controllers/deliveryController');

const router = express.Router();

router.post('/', createDelivery);       // POST /api/delivery
router.get('/', getDeliveries);         // GET /api/delivery
router.get('/:id', getDeliveryById);    // GET /api/delivery/:id
router.put('/:id', updateDelivery);     // PUT /api/delivery/:id
router.patch('/:id/status', updateDeliveryStatus); // PATCH /api/delivery/:id/status
router.delete('/:id', deleteDelivery);  // DELETE /api/delivery/:id

module.exports = router;
