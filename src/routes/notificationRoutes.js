const express = require("express");
const router = express.Router();
const notificationController = require("../controllers/notificationController");

// Save device token
router.post("/update-device-token", notificationController.updateDeviceToken);

// Deactivate device token (logout)
router.post("/deactivate-device-token", notificationController.deactivateDeviceToken);

// Delete device token (hard delete on logout)
router.post("/delete-device-token", notificationController.deleteDeviceToken);

// Get notifications
router.get("/", notificationController.getNotifications);

// Mark notification as read
router.put("/:notificationId/read", notificationController.markNotificationAsRead);

// Mark all notifications as read for a user
router.put("/read-all", notificationController.markAllNotificationsAsRead);

// Test push (DB save + push)
router.post("/test", notificationController.testNotif);
// Test push by direct token (without DB)
router.post("/test-push", notificationController.testPushWithoutDB);

router.post("/send-notification", notificationController.sendNotificationToShop);
router.post("/send-customer", notificationController.sendNotificationToCustomer);

module.exports = router;
