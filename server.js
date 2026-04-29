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

// 打卡 API
app.post('/api/checkin', async (req, res) => {
  try {
    // 1. 新增接收前端傳來的 name 參數
    const { name, phone_last4, location_id, action, lat, lng, token } = req.body;

    if (!phone_last4 || !location_id || !action || !lat || !lng || !token) {
      return res.status(400).json({ success: false, message: '缺少必要參數' });
    }

    // --- (保留您原本的 時間攔截 與 Token 驗證邏輯) ---
    // ...

    // --- 【修改核心】：自動註冊與身分核對邏輯 ---
    let worker;
    const workerRes = await pool.query('SELECT id, name FROM Workers WHERE phone_last4 = $1', [phone_last4]);

    if (workerRes.rows.length === 0) {
      // 狀況 A：資料庫找不到這個人 (初次報到)
      if (action === 'IN') {
        if (!name) return res.status(400).json({ success: false, message: '初次簽到請輸入姓名！' });
        
        // 自動將新人寫入 Workers 資料表
        const newWorkerRes = await pool.query(
          'INSERT INTO Workers (name, phone_last4) VALUES ($1, $2) RETURNING id, name',
          [name, phone_last4]
        );
        worker = newWorkerRes.rows[0]; // 取得剛建好的新員工資料
      } else {
        // 狀況 B：找不到人，但他卻按了「簽退」
        return res.status(404).json({ success: false, message: `找不到手機尾碼 ${phone_last4} 的資料，您尚未簽到！` });
      }
    } else {
      // 狀況 C：資料庫有這個人 (老員工)
      worker = workerRes.rows[0];
    }

    // --- (保留您原本的 查詢場地、計算距離、寫入打卡紀錄邏輯) ---
    const locRes = await pool.query('SELECT * FROM Locations WHERE id = $1', [location_id]);
    if (locRes.rows.length === 0) return res.status(500).json({ success: false, message: '找不到場地資料' });
    const location = locRes.rows[0];

    const distance = getDistanceFromLatLonInM(lat, lng, location.center_lat, location.center_lng);
    if (distance > location.radius_meters) {
      return res.status(403).json({ success: false, message: `打卡失敗：距離太遠 (${distance} 公尺)。` });
    }

    await pool.query(
      'INSERT INTO CheckIns (worker_id, location_id, action, device_gps_lat, device_gps_lng) VALUES ($1, $2, $3, $4, $5)',
      [worker.id, location_id, action, lat, lng]
    );

    // 回傳成功訊息 (如果是初次簽到，可以給予不同提示)
    const actionText = action === 'IN' ? '簽到' : '簽退';
    const welcomeMsg = (action === 'IN' && workerRes.rows.length === 0) ? ' (系統已自動為您建檔)' : '';
    
    res.json({ success: true, message: `✅ ${worker.name}，${actionText}成功！${welcomeMsg}`, distance: distance });

  } catch (err) {
    console.error('打卡 API 錯誤:', err);
    res.status(500).json({ success: false, message: '伺服器內部錯誤' });
  }
});

// --- 新增 API：獲取所有打卡紀錄 (供後台觀看) ---
app.get('/api/records', async (req, res) => {
  try {
    const query = `
      SELECT 
        CheckIns.id,
        Workers.name AS worker_name,
        Locations.location_name,
        CheckIns.action,
        CheckIns.timestamp
      FROM CheckIns
      JOIN Workers ON CheckIns.worker_id = Workers.id
      JOIN Locations ON CheckIns.location_id = Locations.id
      ORDER BY CheckIns.timestamp DESC
    `;
    const result = await pool.query(query);
    res.json({ success: true, records: result.rows });
  } catch (err) {
    console.error('獲取紀錄錯誤:', err);
    res.status(500).json({ success: false, message: '無法獲取紀錄' });
  }
});


// --- 後台管理專區 API ---

// 1. 獲取打卡紀錄 (現在需要密碼了！)
app.post('/api/records', async (req, res) => {
  try {
    const { password } = req.body;
    const sysRes = await pool.query('SELECT admin_password FROM SystemSettings LIMIT 1');
    if (password !== sysRes.rows[0].admin_password) return res.status(403).json({ success: false, message: '密碼錯誤' });

    const result = await pool.query(`
      SELECT CheckIns.id, Workers.name AS worker_name, Locations.location_name, CheckIns.action, CheckIns.timestamp
      FROM CheckIns JOIN Workers ON CheckIns.worker_id = Workers.id JOIN Locations ON CheckIns.location_id = Locations.id
      ORDER BY CheckIns.timestamp DESC
    `);
    res.json({ success: true, records: result.rows });
  } catch (err) { res.status(500).json({ success: false }); }
});

// 2. 獲取目前營業時間 (需密碼)
app.post('/api/settings', async (req, res) => {
  const { password } = req.body;
  const sysRes = await pool.query('SELECT * FROM SystemSettings LIMIT 1');
  if (password !== sysRes.rows[0].admin_password) return res.status(403).json({ success: false });
  res.json({ success: true, open_time: sysRes.rows[0].open_time, close_time: sysRes.rows[0].close_time });
});

// 3. 儲存新的營業時間 (需密碼)
app.put('/api/settings', async (req, res) => {
  const { password, open_time, close_time } = req.body;
  const sysRes = await pool.query('SELECT admin_password FROM SystemSettings LIMIT 1');
  if (password !== sysRes.rows[0].admin_password) return res.status(403).json({ success: false, message: '密碼錯誤' });

  await pool.query('UPDATE SystemSettings SET open_time = $1, close_time = $2', [open_time, close_time]);
  res.json({ success: true, message: '時間設定已更新！' });
});


app.listen(PORT, () => {
  console.log(`🚀 後端伺服器已啟動：http://localhost:${PORT}`);
});