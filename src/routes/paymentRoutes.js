// src/routes/paymentRoutes.js
const express = require("express");
const router = express.Router();
const paymentController = require("../controllers/paymentController");
const requireAdminAuth = require("../middleware/requireAdminAuth");
const requireCustomerAuth = require("../middleware/requireCustomerAuth");

router.get("/", paymentController.getPayments);
router.get('/refunds/booking/:bookingId/status', paymentController.syncCustomerRefundStatus);
router.get('/mode', (req, res) => {
	try {
		const paymongoService = require('../service/paymongoService');
		return res.json({ success: true, ...paymongoService.getMode() });
	} catch (e) {
		return res.status(500).json({ success: false, message: e.message });
	}
});
router.get("/:id", paymentController.getPaymentById);
router.post("/", paymentController.createPayment);
router.post("/gcash/walk-in/:bookingId/create", requireCustomerAuth, paymentController.createWalkInGCashPayment);
router.post("/gcash/walk-in/:bookingId/verify", requireCustomerAuth, paymentController.verifyWalkInGCashPayment);
router.post("/qrph/walk-in/:bookingId/create", requireCustomerAuth, paymentController.createWalkInQrPhPayment);
router.post("/qrph/walk-in/:bookingId/verify", requireCustomerAuth, paymentController.verifyWalkInQrPhPayment);
router.post("/gcash/laundry-request/:bookingId/create", requireCustomerAuth, paymentController.createLaundryRequestGCashPayment);
router.post("/gcash/laundry-request/:bookingId/verify", requireCustomerAuth, paymentController.verifyLaundryRequestGCashPayment);
router.post("/qrph/delivery/:bookingId/create", requireAdminAuth, paymentController.createDeliveryQrPhPayment);
router.post("/qrph/delivery/:bookingId/verify", requireAdminAuth, paymentController.verifyDeliveryQrPhPayment);
router.put("/:id/status", requireAdminAuth, paymentController.updatePaymentStatus);
router.put("/:id/transaction", paymentController.updatePaymentTransaction);
router.get('/shop/:shopId/total', paymentController.getShopSales);

// PayMongo GCash Payment Routes - Temporarily disabled, returns 503 status
router.post("/gcash/create", paymentController.createGCashPayment);
router.get("/gcash/status/:paymentIntentId", paymentController.checkPaymentStatus);
router.post("/gcash/cleanup/:bookingId", paymentController.cleanupFailedGCashBooking);

// Checkout Sessions redirect callbacks (sandbox/test)
router.get('/gcash/checkout/success', paymentController.checkoutSuccess);
router.get('/gcash/checkout/cancel', paymentController.checkoutCancel);

module.exports = router;
