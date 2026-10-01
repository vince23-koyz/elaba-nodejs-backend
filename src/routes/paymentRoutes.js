// src/routes/paymentRoutes.js
const express = require("express");
const router = express.Router();
const paymentController = require("../controllers/paymentController");

router.get("/", paymentController.getPayments);
router.get("/:id", paymentController.getPaymentById);
router.post("/", paymentController.createPayment);
router.put("/:id/status", paymentController.updatePaymentStatus);
router.put("/:id/transaction", paymentController.updatePaymentTransaction);
router.get('/shop/:shopId/total', paymentController.getShopSales);

// PayMongo GCash Payment Routes - Temporarily disabled, returns 503 status
router.post("/gcash/create", paymentController.createGCashPayment);
router.get("/gcash/status/:paymentIntentId", paymentController.checkPaymentStatus);

// Checkout Sessions redirect callbacks (sandbox/test)
router.get('/gcash/checkout/success', paymentController.checkoutSuccess);
router.get('/gcash/checkout/cancel', paymentController.checkoutCancel);

// Payment mode (mock/test/live) info
router.get('/mode', (req, res) => {
	try {
		const paymongoService = require('../service/paymongoService');
		return res.json({ success: true, ...paymongoService.getMode() });
	} catch (e) {
		return res.status(500).json({ success: false, message: e.message });
	}
});

module.exports = router;
