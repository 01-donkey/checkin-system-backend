// routes/checkinRoutes.js
const express = require('express');
const router = express.Router();
const { handleCheckin } = require('../controllers/checkinController');

// 當收到 POST 請求時，交給 handleCheckin 處理
router.post('/', handleCheckin);

module.exports = router;