// routes/bookingRoutes.js
const express = require('express');
const bookingController = require('../controllers/bookingController');
const requireCustomerAuth = require('../middleware/requireCustomerAuth');
const requireAdminAuth = require('../middleware/requireAdminAuth');

const router = express.Router();

// Defensive checks to make debugging clearer if a handler isn't exported correctly
const ensureFn = (fn, name) => {
  if (typeof fn !== 'function') {
    throw new TypeError(`bookingController.${name} must be a function but got ${typeof fn}`);
  }
  return fn;
};

router.post('/', (req, res, next) => {
  if (req.body?.request_mode === 'laundry_request') {
    return requireCustomerAuth(req, res, next);
  }
  return next();
}, ensureFn(bookingController.createBooking, 'createBooking'));       // POST /api/bookings
router.get('/', ensureFn(bookingController.getBookings, 'getBookings'));            // GET /api/bookings
router.get('/:id', ensureFn(bookingController.getBookingById, 'getBookingById'));  // GET /api/bookings/:id
router.patch('/:id/confirm-pickup', requireAdminAuth, ensureFn(bookingController.confirmPickupRequest, 'confirmPickupRequest'));
router.patch('/:id/price-confirmation', requireAdminAuth, ensureFn(bookingController.submitBookingPriceConfirmation, 'submitBookingPriceConfirmation'));
router.patch('/:id/payment-method', requireCustomerAuth, ensureFn(bookingController.selectLaundryRequestPaymentMethod, 'selectLaundryRequestPaymentMethod'));
router.put('/:id', requireAdminAuth, ensureFn(bookingController.updateBooking, 'updateBooking'));     // PUT /api/bookings/:id
router.patch('/:id/status', (req, res, next) => {
  if (String(req.body?.status || '').toLowerCase() === 'completed') {
    return requireAdminAuth(req, res, next);
  }
  return next();
}, ensureFn(bookingController.updateBookingStatus, 'updateBookingStatus')); // PATCH /api/bookings/:id/status
router.delete('/:id', ensureFn(bookingController.deleteBooking, 'deleteBooking'));  // DELETE /api/bookings/:id

module.exports = router;
