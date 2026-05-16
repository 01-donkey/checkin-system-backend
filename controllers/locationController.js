// controllers/locationController.js
const pool = require('../database'); // 🌟 引入資料庫連線 (注意路徑是 ../)

// 獲取場地列表的核心邏輯
const getLocations = async (req, res) => {
  try {
    const result = await pool.query('SELECT id, location_name FROM Locations');
    res.json({ success: true, locations: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: '無法獲取場地資料' });
  }
};

// 將這個功能匯出
module.exports = {
  getLocations
};