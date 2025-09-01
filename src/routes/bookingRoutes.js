// routes/bookingRoutes.js
const express = require('express');
const {
  createBooking,
  getBookings,
  getBookingById,
  updateBooking,
  updateBookingStatus,
  deleteBooking
} = require('../controllers/bookingController');

const router = express.Router();

router.post('/', createBooking);       // POST /api/bookings
router.get('/', getBookings);          // GET /api/bookings (with optional ?shop_id=X filter)
router.get('/:id', getBookingById);    // GET /api/bookings/:id
router.put('/:id', updateBooking);     // PUT /api/bookings/:id
router.patch('/:id/status', updateBookingStatus); // PATCH /api/bookings/:id/status
router.delete('/:id', deleteBooking);  // DELETE /api/bookings/:id

module.exports = router;
