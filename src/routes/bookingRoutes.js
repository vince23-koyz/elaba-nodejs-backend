// routes/bookingRoutes.js
const express = require('express');
const bookingController = require('../controllers/bookingController');

const router = express.Router();

// Defensive checks to make debugging clearer if a handler isn't exported correctly
const ensureFn = (fn, name) => {
  if (typeof fn !== 'function') {
    throw new TypeError(`bookingController.${name} must be a function but got ${typeof fn}`);
  }
  return fn;
};

router.post('/', ensureFn(bookingController.createBooking, 'createBooking'));       // POST /api/bookings
router.get('/', ensureFn(bookingController.getBookings, 'getBookings'));            // GET /api/bookings
router.get('/reschedules', ensureFn(bookingController.getRescheduleRequests, 'getRescheduleRequests'));
router.patch('/reschedules/:id/approve', ensureFn(bookingController.approveReschedule, 'approveReschedule'));
router.patch('/reschedules/:id/reject', ensureFn(bookingController.rejectReschedule, 'rejectReschedule'));
router.get('/:id', ensureFn(bookingController.getBookingById, 'getBookingById'));  // GET /api/bookings/:id
router.get('/:id/reschedule', ensureFn(bookingController.getRescheduleRequest, 'getRescheduleRequest'));
router.post('/:id/reschedule', ensureFn(bookingController.createRescheduleRequest, 'createRescheduleRequest'));
router.put('/:id', ensureFn(bookingController.updateBooking, 'updateBooking'));     // PUT /api/bookings/:id
router.patch('/:id/status', ensureFn(bookingController.updateBookingStatus, 'updateBookingStatus')); // PATCH /api/bookings/:id/status
router.delete('/:id', ensureFn(bookingController.deleteBooking, 'deleteBooking'));  // DELETE /api/bookings/:id

module.exports = router;
