const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');

// 🌟 從 controller 拿出警衛
const { requireAdminPassword } = adminController;

// 🌟 把警衛插在路徑和處理功能的中間
router.post('/records', requireAdminPassword, adminController.getRecords);
router.post('/settings', requireAdminPassword, adminController.getSettings);
router.put('/settings', requireAdminPassword, adminController.updateSettings);
router.post('/export', requireAdminPassword, adminController.exportCsv);
router.post('/roster', requireAdminPassword, adminController.importRoster);
router.post('/roster/list', requireAdminPassword, adminController.getRosterList);

module.exports = router;