// server.js
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const pool = require('./database'); // 現在引入的是 pg pool

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET_KEY = 'SNA_COSTA_SUPER_SECRET_KEY';

app.use(cors());
app.use(express.json());

function getDistanceFromLatLonInM(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return Math.round(R * c);
}

// 獲取場地列表 API
app.get('/api/locations', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, location_name FROM Locations');
    res.json({ success: true, locations: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: '無法獲取場地資料' });
  }
});

// 產生 Token API
app.get('/api/qr-token', (req, res) => {
  const location_id = req.query.location_id || 1;
  const timestamp = Date.now();
  const signature = crypto.createHmac('sha256', SECRET_KEY).update(`${location_id}:${timestamp}`).digest('hex');
  res.json({ success: true, token: `${timestamp}.${signature}`, location_id: location_id });
});

// 接收打卡 API
app.post('/api/checkin', async (req, res) => {
  try {
    const { phone_last4, location_id, action, lat, lng, token } = req.body;

    if (!phone_last4 || !location_id || !action || !lat || !lng || !token) {
      return res.status(400).json({ success: false, message: '缺少必要參數' });
    }

    // 驗證 Token
    const [qrTimestamp, qrSignature] = token.split('.');
    const expectedSignature = crypto.createHmac('sha256', SECRET_KEY).update(`${location_id}:${qrTimestamp}`).digest('hex');

    if (qrSignature !== expectedSignature) return res.status(403).json({ success: false, message: '無效的打卡條碼！' });
    if (Date.now() - parseInt(qrTimestamp) > 15000) return res.status(403).json({ success: false, message: '條碼已過期！請重新掃描。' });

    // 查詢員工
    const workerRes = await pool.query('SELECT id, name FROM Workers WHERE phone_last4 = $1', [phone_last4]);
    if (workerRes.rows.length === 0) return res.status(404).json({ success: false, message: `找不到手機尾碼 ${phone_last4} 的員工` });
    const worker = workerRes.rows[0];

    // 查詢場地
    const locRes = await pool.query('SELECT * FROM Locations WHERE id = $1', [location_id]);
    if (locRes.rows.length === 0) return res.status(500).json({ success: false, message: '找不到場地資料' });
    const location = locRes.rows[0];

    // 計算距離
    const distance = getDistanceFromLatLonInM(lat, lng, location.center_lat, location.center_lng);
    if (distance > location.radius_meters) {
      return res.status(403).json({ success: false, message: `打卡失敗：距離太遠 (${distance} 公尺)。` });
    }

    // 寫入打卡紀錄
    await pool.query(
      'INSERT INTO CheckIns (worker_id, location_id, action, device_gps_lat, device_gps_lng) VALUES ($1, $2, $3, $4, $5)',
      [worker.id, location_id, action, lat, lng]
    );

    const actionText = action === 'IN' ? '簽到' : '簽退';
    res.json({ success: true, message: `✅ ${worker.name}，${actionText}成功！`, distance: distance });

  } catch (err) {
    console.error('打卡 API 錯誤:', err);
    res.status(500).json({ success: false, message: '伺服器內部錯誤' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 後端伺服器已啟動：http://localhost:${PORT}`);
});