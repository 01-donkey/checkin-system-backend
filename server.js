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

app.post('/api/checkin', async (req, res) => {
  try {
    const { name, phone_last4, location_id, action, lat, lng, token } = req.body;

    if (!phone_last4 || !location_id || !action || !lat || !lng || !token) {
      return res.status(400).json({ success: false, message: '缺少必要參數' });
    }

    // 1. 攔截非營業時間
    const settingRes = await pool.query('SELECT open_time, close_time FROM SystemSettings LIMIT 1');
    const { open_time, close_time } = settingRes.rows[0];
    const tpeTime = new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei', hour12: false, hour: '2-digit', minute: '2-digit' });
    
    if (tpeTime < open_time || tpeTime > close_time) {
      return res.status(403).json({ success: false, message: `目前非開放打卡時間 (${open_time} - ${close_time})，系統已關閉。` });
    }

    // 2. 驗證 Token
    const [qrTimestamp, qrSignature] = token.split('.');
    const expectedSignature = crypto.createHmac('sha256', SECRET_KEY).update(`${location_id}:${qrTimestamp}`).digest('hex');
    if (qrSignature !== expectedSignature) return res.status(403).json({ success: false, message: '無效的打卡條碼！' });
    if (Date.now() - parseInt(qrTimestamp) > 120000) return res.status(403).json({ success: false, message: '條碼已過期！請重新掃描。' });

    // 3. 查詢或自動註冊員工
    let worker;
    const workerRes = await pool.query('SELECT id, name FROM Workers WHERE phone_last4 = $1', [phone_last4]);

    if (workerRes.rows.length === 0) {
      if (action === 'IN') {
        if (!name) return res.status(400).json({ success: false, message: '初次簽到請輸入姓名！' });
        const newWorkerRes = await pool.query(
          'INSERT INTO Workers (name, phone_last4) VALUES ($1, $2) RETURNING id, name',
          [name, phone_last4]
        );
        worker = newWorkerRes.rows[0];
      } else {
        return res.status(404).json({ success: false, message: `找不到手機尾碼 ${phone_last4} 的資料，您尚未簽到！` });
      }
    } else {
      worker = workerRes.rows[0];
    }

    // ---------------------------------------------------------
    // 🛡️ 【新增：雙重防呆機制】 🛡️
    // ---------------------------------------------------------
    const lastRecordRes = await pool.query(
      'SELECT action, timestamp FROM CheckIns WHERE worker_id = $1 ORDER BY timestamp DESC LIMIT 1',
      [worker.id]
    );

    if (lastRecordRes.rows.length > 0) {
      const lastRecord = lastRecordRes.rows[0];
      const lastTime = new Date(lastRecord.timestamp).getTime();
      const now = Date.now();
      const diffMinutes = (now - lastTime) / (1000 * 60); // 計算距離上次打卡過了幾分鐘

      // 第一重：1 分鐘內禁止連續打卡 (防手抖連點)
      if (diffMinutes < 1) {
        return res.status(403).json({ success: false, message: `打卡太頻繁！請等待 1 分鐘後再試。` });
      }

      // 第二重：狀態邏輯防呆 (假設 12 小時內的紀錄才算同一班別，超過 12 小時視為隔天新班表)
      if (diffMinutes < 12 * 60) {
        if (action === 'IN' && lastRecord.action === 'IN') {
          return res.status(403).json({ success: false, message: `您目前已經是「簽到」狀態，請勿重複簽到！` });
        }
        if (action === 'OUT' && lastRecord.action === 'OUT') {
          return res.status(403).json({ success: false, message: `您目前已經是「簽退」狀態，請勿重複簽退！` });
        }
      }
    }
    // ---------------------------------------------------------

    // 4. 查詢場地與計算距離
    const locRes = await pool.query('SELECT * FROM Locations WHERE id = $1', [location_id]);
    if (locRes.rows.length === 0) return res.status(500).json({ success: false, message: '找不到場地資料' });
    const location = locRes.rows[0];

    const distance = getDistanceFromLatLonInM(lat, lng, location.center_lat, location.center_lng);
    if (distance > location.radius_meters) {
      return res.status(403).json({ success: false, message: `打卡失敗：距離太遠 (${distance} 公尺)。` });
    }

    // 5. 寫入打卡紀錄
    await pool.query(
      'INSERT INTO CheckIns (worker_id, location_id, action, device_gps_lat, device_gps_lng) VALUES ($1, $2, $3, $4, $5)',
      [worker.id, location_id, action, lat, lng]
    );

    const actionText = action === 'IN' ? '簽到' : '簽退';
    const welcomeMsg = (action === 'IN' && workerRes.rows.length === 0) ? ' (系統已為您建檔)' : '';
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

// 4. 匯出 CSV 報表 (包含自動計算工時)
app.post('/api/export', async (req, res) => {
  try {
    const { password } = req.body;
    const sysRes = await pool.query('SELECT admin_password FROM SystemSettings LIMIT 1');
    if (password !== sysRes.rows[0].admin_password) return res.status(403).json({ success: false, message: '密碼錯誤' });

    // 撈取所有紀錄，依照時間順序排列
    const result = await pool.query(`
      SELECT CheckIns.worker_id, Workers.name AS worker_name, Locations.location_name, CheckIns.action, CheckIns.timestamp
      FROM CheckIns 
      JOIN Workers ON CheckIns.worker_id = Workers.id 
      JOIN Locations ON CheckIns.location_id = Locations.id
      ORDER BY CheckIns.timestamp ASC
    `);

    // 核心邏輯：將凌亂的紀錄依據「員工+日期」進行分組
    const dailyData = {};

    result.rows.forEach(r => {
      // 轉換成台灣時間處理
      const dateObj = new Date(r.timestamp);
      const dateStr = dateObj.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' }); // 例：2026/4/29
      const timeStr = dateObj.toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
      
      const key = `${r.worker_id}_${dateStr}`; // 唯一識別碼：員工ID_日期

      if (!dailyData[key]) {
        dailyData[key] = {
          name: r.worker_name,
          date: dateStr,
          location: r.location_name,
          inTimeObj: null,
          outTimeObj: null,
          inTimeStr: '未簽到',
          outTimeStr: '未簽退',
          totalHours: 0
        };
      }

      // 如果是簽到，且當天還沒簽到過 (抓取當天最早的一筆)
      if (r.action === 'IN' && !dailyData[key].inTimeObj) {
        dailyData[key].inTimeObj = dateObj;
        dailyData[key].inTimeStr = timeStr;
      } 
      // 如果是簽退 (不斷覆蓋，抓取當天最晚的一筆)
      else if (r.action === 'OUT') {
        dailyData[key].outTimeObj = dateObj;
        dailyData[key].outTimeStr = timeStr;
      }
    });

    // 組合 CSV 字串 (\uFEFF 是為了讓 Excel 讀取中文不亂碼)
    let csvContent = '\uFEFF姓名,日期,場地,簽到時間,簽退時間,總工時(小時)\n';
    
    Object.values(dailyData).forEach(d => {
      // 如果有簽到也有簽退，就計算總工時
      if (d.inTimeObj && d.outTimeObj) {
        const diffMs = d.outTimeObj - d.inTimeObj;
        d.totalHours = (diffMs / (1000 * 60 * 60)).toFixed(2); // 換算成小時，取到小數點後兩位
      }
      csvContent += `${d.name},${d.date},${d.location},${d.inTimeStr},${d.outTimeStr},${d.totalHours}\n`;
    });

    // 設定回傳格式為 CSV 檔案
    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.send(csvContent);

  } catch (err) {
    console.error('匯出錯誤:', err);
    res.status(500).json({ success: false, message: '伺服器內部錯誤' });
  }
});


app.listen(PORT, () => {
  console.log(`🚀 後端伺服器已啟動：http://localhost:${PORT}`);
});