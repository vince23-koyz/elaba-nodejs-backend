const express = require('express');
const router = express.Router();
const superAdminController = require('../controllers/superAdminController');

// Login
router.post('/login', superAdminController.loginSuperAdmin);
router.put('/:id/profile', superAdminController.updateProfile);
router.post('/:id/change-password', superAdminController.changePassword);
router.get('/shop-documents', superAdminController.getSavedShopDocuments);
router.delete('/shop-documents/:id', superAdminController.deleteSavedShopDocument);
router.delete('/shop-documents/orphaned/all', superAdminController.deleteAllOrphanedDocuments);
router.post('/cleanup-rejected-documents', superAdminController.cleanupRejectedDocuments);

// Dashboard stats
router.get('/dashboard/stats', superAdminController.getDashboardStats);
router.get('/revenue-analytics', superAdminController.getRevenueAnalytics);

module.exports = router;
