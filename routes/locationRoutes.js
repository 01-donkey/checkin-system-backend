// routes/locationRoutes.js
const express = require('express');
const router = express.Router();
const { getLocations } = require('../controllers/locationController'); // 🌟 引入業務部門的功能

// 當有人對這個路線發出 GET 請求時，交給 getLocations 處理
router.get('/', getLocations);

module.exports = router;