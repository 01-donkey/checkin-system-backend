// routes/qrRoutes.js
const express = require('express');
const router = express.Router();
const { generateQrToken, getKioskToken } = require('../controllers/qrController');

// 🌟【新增】：設定換取 Token 的路線 (必須放在 / 的上面)
router.post('/kiosk-token', getKioskToken); 

// 原本產生條碼的路線
router.post('/', generateQrToken);

module.exports = router;