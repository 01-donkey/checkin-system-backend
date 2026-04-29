// server.js
const express = require('express');
const cors = require('cors');
const db = require('./database');

const app = express();
const PORT = 3000;

// 啟用 CORS 與 JSON 解析
app.use(cors());
app.use(express.json());

// --- 核心演算法：計算兩個經緯度之間的距離 (單位：公尺) ---
function getDistanceFromLatLonInM(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // 地球半徑 (公尺)
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return Math.round(R * c); // 回傳四捨五入的公尺數
}

// --- API：接收打卡請求 ---
app.post('/api/checkin', (req, res) => {
const { worker_id, location_id, action, lat, lng, token } = req.body;

  // 確保前端有傳來 token
  if (!worker_id || !location_id || !lat || !lng || !token) {
    return res.status(400).json({ success: false, message: '缺少必要參數或未經授權的掃碼' });
  }

  // --- 【新增】驗證 Token ---
  const [qrTimestamp, qrSignature] = token.split('.');
  const expectedSignature = crypto.createHmac('sha256', SECRET_KEY).update(`${location_id}:${qrTimestamp}`).digest('hex');

  if (qrSignature !== expectedSignature) {
    return res.status(403).json({ success: false, message: '無效的打卡條碼！' });
  }

  // 檢查是否過期 (例如設定 15 秒 = 15000 毫秒)
  const timeDiff = Date.now() - parseInt(qrTimestamp);
  if (timeDiff > 150000) {
    return res.status(403).json({ success: false, message: '條碼已過期！請重新掃描現場螢幕。' });
  }
  // --- Token 驗證通過，接續原本的距離驗證邏輯 ---

  // 1. 從資料庫撈取該場地的中心點與容許半徑
  db.get(`SELECT * FROM Locations WHERE id = ?`, [location_id], (err, location) => {
    if (err || !location) return res.status(500).json({ success: false, message: '找不到場地資料' });

    // 2. 計算工讀生手機座標與場地中心的距離
    const distance = getDistanceFromLatLonInM(lat, lng, location.center_lat, location.center_lng);

    // 3. 驗證距離是否超過半徑
    if (distance > location.radius_meters) {
      return res.status(403).json({ 
        success: false, 
        message: `打卡失敗：您距離工作地點太遠 (${distance} 公尺)，請靠近現場再試一次。` 
      });
    }
    // 4. 驗證通過，將打卡紀錄寫入資料庫
    const stmt = db.prepare(`INSERT INTO CheckIns (worker_id, location_id, action, device_gps_lat, device_gps_lng) VALUES (?, ?, ?, ?, ?)`);
    stmt.run(worker_id, location_id, action, lat, lng, function(err) {
      if (err) return res.status(500).json({ success: false, message: '資料寫入失敗' });
      
      res.json({ 
        success: true, 
        message: '✅ 打卡成功！', 
        distance: distance 
      });
    });
    stmt.finalize();
  });
});

// 啟動伺服器
app.listen(PORT, () => {
  console.log(`🚀 後端伺服器已啟動：http://localhost:${PORT}`);
});

// 在 server.js 最上方引入內建的加密模組
const crypto = require('crypto');

// 設定一個系統私鑰 (實務上這會放在環境變數 .env 裡，這裡為了教學先寫死)
const SECRET_KEY = 'SNA_COSTA_SUPER_SECRET_KEY';

// --- 新增 API：產生動態 QR Code Token ---
app.get('/api/qr-token', (req, res) => {
  const location_id = req.query.location_id || 1;
  const timestamp = Date.now(); // 取得當下時間的毫秒數

  // 將「場地ID」與「時間戳記」組合成字串，並用私鑰進行 HMAC-SHA256 加密
  const dataToSign = `${location_id}:${timestamp}`;
  const signature = crypto.createHmac('sha256', SECRET_KEY).update(dataToSign).digest('hex');

  // 將時間戳記與簽名組合成最終的 Token
  const token = `${timestamp}.${signature}`;
  
  res.json({ success: true, token: token, location_id: location_id });
});

// --- 新增 API：獲取所有場地列表 (供看板下拉選單使用) ---
app.get('/api/locations', (req, res) => {
  db.all(`SELECT id, location_name FROM Locations`, [], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: '無法獲取場地資料' });
    res.json({ success: true, locations: rows });
  });
});