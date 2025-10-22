// routes/serviceRoutes.js
const express = require('express');
const {
  createService,
  getServices,
  getServiceById,
  updateService,
  deleteService,
  getServicesByShop
} = require('../controllers/serviceController');

const router = express.Router();

router.post('/', createService);       // POST /api/services
router.get('/', getServices);          // GET /api/services
router.get('/:id', getServiceById);    // GET /api/services/:id
router.get('/shop/:shop_id', getServicesByShop); // GET /api/services/shop/:shop_id
router.put('/:id', updateService);     // PUT /api/services/:id
router.delete('/:id', deleteService);  // DELETE /api/services/:id

module.exports = router;
