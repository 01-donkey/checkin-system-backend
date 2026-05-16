// server.js
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const pool = require('./database'); // 現在引入的是 pg pool
const bcrypt = require('bcrypt'); // 🌟【新增】引入加密套件
require('dotenv').config(); // 🌟【新增】這行用來啟動保險箱

const helmet = require('helmet'); // 🌟【新增】引入 Helmet 安全防護罩
const morgan = require('morgan'); // 🌟【新增】引入監視錄影機

const rateLimit = require('express-rate-limit'); // 🌟【新增】引入流量管制員

// 呼叫
const { getDistanceFromLatLonInM } = require('./utils/helper');
const locationRoutes = require('./routes/locationRoutes');
const checkinRoutes = require('./routes/checkinRoutes');
const adminRoutes = require('./routes/adminRoutes'); // 🌟 新增後台櫃檯
const qrRoutes = require('./routes/qrRoutes'); // 🌟 新增：引入條碼櫃檯

const app = express();

app.use(helmet()); // 🌟【新增】啟用 Helmet，幫助設定安全的 HTTP 標頭
// 建議：依環境自動切換
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

const PORT = process.env.PORT || 3000;
const SECRET_KEY = process.env.SECRET_KEY; // 🌟【新增】從 .env 檔案讀取簽章密鑰，確保安全性

// 🌟【新增】防呆機制：如果忘記設定金鑰，系統會直接報錯提醒
if (!SECRET_KEY) {
  console.error('🚨 致命錯誤：找不到 SECRET_KEY 環境變數！');
  process.exit(1);
}

// 🌟【升級】：設定嚴格的 CORS 白名單，只允許自己的前端連線
const allowedOrigins = [
  'http://localhost:4321',                      // 本地端測試用的網址 (Astro 預設)
  'https://checkin-system-frontend.vercel.app'  // 您的正式雲端前端網址 (若未來有改名，記得來這裡更新)
];

app.use(cors({
  origin: function (origin, callback) {
    // 如果沒有 origin (例如 Postman 測試或同源請求)，或是 origin 在白名單內，就放行
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      // 不在白名單內的陌生網站，直接無情拒絕！
      callback(new Error('🛑 CORS 阻擋：不允許的跨域連線！'));
    }
  },
  methods: ['GET', 'POST', 'PUT'], // 只允許這三種安全的請求動作
}));


app.use(express.json({ limit: '100kb' })); // 🌟【新增】限制請求體積最大為 100KB，防止惡意大數據攻擊

// 🌟【新增】：設定流量管制規則
// 規則 A：給「後台登入」用的（每 15 分鐘最多只能嘗試 20 次密碼）
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 分鐘
  max: 20, // 限制次數
  message: { success: false, message: '🛑 嘗試次數過多，請等待 15 分鐘後再試！' }
});

// 🟢 規則 B：給「後台日常操作」用的（例如切換日期、更新名單）- 1分鐘60次
const adminActionLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, 
  max: 60, // 讓管理員可以一秒點一次，非常寬鬆但又能防禦惡意腳本
  message: { success: false, message: '🛑 操作過於頻繁，請稍等 1 分鐘！' }
});

// 規則 C：給「現場打卡」用的（每個 IP 每分鐘最多只能打卡 10 次，防止惡意狂點）
const checkinLimiter = rateLimit({ 
  windowMs: 60 * 1000, // 1 分鐘
  max: 10,
  message: { success: false, message: '🛑 動作太頻繁，請稍等 1 分鐘後再試！' }
});

// 🌟【新增】：規則 C：給「現場機台生條碼」專用的（每分鐘最高 30 次）
const kioskLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 分鐘
  max: 30, // 機台每 5 秒要一次，一分鐘約 12 次，設 30 次非常安全
  message: { success: false, message: '🛑 條碼機請求過於頻繁' }
});

// 🌟【新增】：把管制規則套用到對應的大門 (API 路徑) 上
/* app.use('/api/settings', authLimiter);
app.use('/api/records', authLimiter);
app.use('/api/export', authLimiter);
app.use('/api/roster', authLimiter);
app.use('/api/roster/list', authLimiter); */
/* app.use('/api/qr-token', authLimiter); // 產生條碼也要防護 */

// 1. 換鑰匙 (需要輸入密碼)：套用嚴格防護，防止駭客暴力破解密碼
app.use('/api/qr-token/kiosk-token', authLimiter); 

// 2. 每 5 秒生條碼：套用我們剛寫的寬鬆防護，保證機台順暢運作
app.use('/api/qr-token', kioskLimiter, qrRoutes);

app.use('/api/locations', locationRoutes);
app.use('/api/checkin', checkinLimiter, checkinRoutes);
app.use('/api', adminActionLimiter, adminRoutes); // 後台管理的 API 都加上嚴格的密碼驗證與流量管制


/* // 獲取場地列表 API
app.get('/api/locations', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, location_name FROM Locations');
    res.json({ success: true, locations: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: '無法獲取場地資料' });
  }
}); */

/* // 🌟【升級】：改為 POST 請求，並加上密碼驗證與最高時效限制
app.post('/api/qr-token', async (req, res) => {
  try {
    const { password, location_id = 1, duration = 90000 } = req.body;

    // 1. 驗證管理員密碼 (防止路人亂生條碼)
    const sysRes = await pool.query('SELECT admin_password FROM SystemSettings LIMIT 1');
    const isValid = await bcrypt.compare(password, sysRes.rows[0].admin_password);
    if (!isValid) return res.status(403).json({ success: false, message: '無效的請求：驗證失敗' });

    // 2. 限制最大時效為 24 小時 (防呆防駭客)
    const MAX_DURATION = 24 * 60 * 60 * 1000;
    const safeDuration = Math.min(parseInt(duration), MAX_DURATION);

    const timestamp = Date.now();
    // 🛡️ 新版簽章：把「存活時間」也加進去一起加密防偽
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(`${location_id}:${timestamp}:${safeDuration}`).digest('hex');
    
    // 回傳的 token 變成 3 段式：時間戳.存活時間.簽章
    res.json({ success: true, token: `${timestamp}.${safeDuration}.${signature}`, location_id: location_id });
  } catch (err) {
    console.error('產生 Token 失敗:', err);
    res.status(500).json({ success: false, message: '伺服器錯誤' });
  }
}); */

/* // 打卡 API
app.post('/api/checkin', async (req, res) => {
  try {
// 1. 接收前端傳來的參數 (新增 group 與 work_log)
// 接收參數說明：
    const { name, phone_last4, location_id, action, lat, lng, token, group, sub_group, special_status, bento } = req.body;

    // 把原本的 !group 拿掉，改到下面分開判斷
    if (!phone_last4 || !location_id || !action || !lat || !lng || !token) {
      return res.status(400).json({ success: false, message: '缺少必要參數' });
    }
    // 只有簽退時，才強制要求組別
    if (action === 'OUT' && !group) {
      return res.status(400).json({ success: false, message: '簽退時請確認是否已選擇組別' });
    }

// 攔截非營業時間 (🌟 升級：獲取標準時間，並計算時間校正)
    const settingRes = await pool.query('SELECT open_time, close_time FROM SystemSettings LIMIT 1');
    const { open_time, close_time } = settingRes.rows[0];
    
    const now = new Date();
    // 取得台灣時間的各項數值
    const yyyy = now.toLocaleString('en-US', { timeZone: 'Asia/Taipei', year: 'numeric' });
    const mm = now.toLocaleString('en-US', { timeZone: 'Asia/Taipei', month: '2-digit' });
    const dd = now.toLocaleString('en-US', { timeZone: 'Asia/Taipei', day: '2-digit' });
    const ss = now.toLocaleString('en-US', { timeZone: 'Asia/Taipei', second: '2-digit' });
    const tpeHour = parseInt(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei', hour12: false, hour: 'numeric' }).match(/\d+/)[0]);
    const tpeMin = parseInt(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei', minute: 'numeric' }).match(/\d+/)[0]);
    const currentMinutes = tpeHour * 60 + tpeMin;

    const [openH, openM] = open_time.split(':').map(Number);
    const [closeH, closeM] = close_time.split(':').map(Number);
    const openMinutes = openH * 60 + openM;
    const closeMinutes = closeH === 24 ? 24 * 60 : closeH * 60 + closeM;

    // 🌟【放寬大門】：允許上班前 60 分鐘 ~ 下班後 120 分鐘都可以操作打卡，避免員工提早到卻無法打卡
    if (currentMinutes < openMinutes - 60 || currentMinutes > closeMinutes + 120) {
      return res.status(403).json({ success: false, message: `目前非開放打卡時間！(開放區間：${open_time} 前一小時 ~ ${close_time} 後兩小時)` });
    }

    // 🌟【新增核心邏輯】：時間校正魔法
    let finalHour = tpeHour;
    let finalMin = tpeMin;
    let isAdjusted = false;

    if (action === 'IN') {
      // 規定：上班前 10 分鐘 ~ 後 15 分鐘都算起始時間
      if (currentMinutes >= openMinutes - 10 && currentMinutes <= openMinutes + 15) {
        finalHour = openH;
        finalMin = openM;
        isAdjusted = true;
      }
    } else if (action === 'OUT') {
      // 規定：下班後 20 分鐘都算終點時間 (註：下班若提前打，不校正，保留真實早退時間)
      if (currentMinutes >= closeMinutes && currentMinutes <= closeMinutes + 20) {
        finalHour = closeH;
        finalMin = closeM;
        isAdjusted = true;
      }
    }
    const finalSec = isAdjusted ? '00' : ss;
    // 產生精準的 Date 物件 (防範伺服器時區飄移，強制鎖定台灣 +08:00)
    const dbDateObj = new Date(`${yyyy}-${mm}-${dd}T${String(finalHour).padStart(2, '0')}:${String(finalMin).padStart(2, '0')}:${finalSec}+08:00`);

// 驗證 Token (支援動態 90 秒與自訂長時效)
    const parts = token.split('.');
    if (parts.length !== 3) return res.status(403).json({ success: false, message: '打卡條碼格式錯誤或已失效！' });
    
    const [qrTimestamp, qrDuration, qrSignature] = parts;
    const expectedSignature = crypto.createHmac('sha256', SECRET_KEY).update(`${location_id}:${qrTimestamp}:${qrDuration}`).digest('hex');
    
    if (qrSignature !== expectedSignature) return res.status(403).json({ success: false, message: '無效的打卡條碼！' });
    if (Date.now() - parseInt(qrTimestamp) > parseInt(qrDuration)) {
      return res.status(403).json({ success: false, message: '⏱️ 此條碼已過期！請向管理員索取新條碼。' });
    }



// 查詢或自動註冊員工
    let worker;
    const workerRes = await pool.query('SELECT id, name, device_uuid FROM Workers WHERE phone_last4 = $1', [phone_last4]);

    if (workerRes.rows.length === 0) {
      if (action === 'IN') {
        if (!name) return res.status(400).json({ success: false, message: '初次簽到請輸入姓名！' });
        
  // 🔄 【修改後】(刪掉 device_uuid 的部分)：
        const newWorkerRes = await pool.query(
          'INSERT INTO Workers (name, phone_last4, worker_group) VALUES ($1, $2, $3) RETURNING id, name',
          [name, phone_last4, '尚未選擇']
        );
        worker = newWorkerRes.rows[0];
      } else {
        return res.status(404).json({ success: false, message: `找不到生日四碼 ${phone_last4} 的資料！` });
      }
    } else {
      worker = workerRes.rows[0];

      // 更新組別等邏輯維持原樣...
      if (group) {
        await pool.query('UPDATE Workers SET worker_group = $1, sub_group = $2 WHERE id = $3', [group, sub_group || null, worker.id]);
      }
    }

    // 【保留】防手抖防呆：30秒內禁止連續點擊
    const lastRecordRes = await pool.query('SELECT timestamp FROM CheckIns WHERE worker_id = $1 ORDER BY timestamp DESC LIMIT 1', [worker.id]);
    if (lastRecordRes.rows.length > 0) {
      const diffSeconds = (Date.now() - new Date(lastRecordRes.rows[0].timestamp).getTime()) / 1000;
      if (diffSeconds < 30) return res.status(403).json({ success: false, message: `打卡太頻繁！請等待 30 秒後再試。` });
    }

    // 查詢場地與計算距離
    const locRes = await pool.query('SELECT * FROM Locations WHERE id = $1', [location_id]);
    if (locRes.rows.length === 0) return res.status(500).json({ success: false, message: '找不到場地資料' });
    const location = locRes.rows[0];
    const distance = getDistanceFromLatLonInM(lat, lng, location.center_lat, location.center_lng);
    if (distance > location.radius_meters) return res.status(403).json({ success: false, message: `打卡失敗：距離太遠 (${distance} 公尺)。` });
    // 🚨 【新增】：嚴格排班白名單檢查
    // 1. 先看「今天」到底有沒有上傳班表？
    const rosterCheck = await pool.query(
      `SELECT count(*) FROM DailyRoster WHERE work_date = CURRENT_DATE AT TIME ZONE 'Asia/Taipei'`
    );
    
    // 2. 如果今天有班表 (>0)，就啟動嚴格檢查模式！
    if (parseInt(rosterCheck.rows[0].count) > 0) {
      const myRoster = await pool.query(
        `SELECT id FROM DailyRoster 
         WHERE phone_last4 = $1 AND work_date = CURRENT_DATE AT TIME ZONE 'Asia/Taipei'`,
        [phone_last4]
      );
      if (myRoster.rows.length === 0) {
        return res.status(403).json({ 
          success: false, 
          message: `🛑 拒絕打卡：您今天沒有排班喔！請與管理員確認。` 
        });
      }
    }
    // (如果今天沒班表，就預設放行，避免管理員忘記上傳導致全體無法上班)
    // ---------------------------------------------------------
    // 🛡️ 【改成】：嚴格禁止重複打卡邏輯 🛡️
    // ---------------------------------------------------------
    const todayRecordRes = await pool.query(
      `SELECT id, timestamp FROM CheckIns 
       WHERE worker_id = $1 AND location_id = $2 AND action = $3 
       AND timestamp >= CURRENT_DATE AT TIME ZONE 'Asia/Taipei'
       AND timestamp < (CURRENT_DATE + 1) AT TIME ZONE 'Asia/Taipei'
       LIMIT 1`,
      [worker.id, location_id, action]
    );

    if (todayRecordRes.rows.length > 0) {
      // 狀況 A：今天已經有紀錄了 ➡️ 直接拒絕，不給覆蓋！
      const oldTime = new Date(todayRecordRes.rows[0].timestamp).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
      const actionText = action === 'IN' ? '簽到' : '簽退';
      
      return res.status(403).json({ 
        success: false, 
        message: `重複打卡：您今天在 ${oldTime} 已經完成過「${actionText}」了！` 
      });
      
} else {
      // 狀況 B：今天還沒打過卡 ➡️ 正常執行 INSERT 新增
      const logToSave = action === 'IN' ? bento : null;
      // 🛡️ 【修改 1】：把原本自動抓現在時間的寫法，換成我們算好的 dbDateObj
      await pool.query(
        'INSERT INTO CheckIns (worker_id, location_id, action, device_gps_lat, device_gps_lng, work_log, timestamp) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [worker.id, location_id, action, lat, lng, logToSave, dbDateObj]
      );
      
      const actionText = action === 'IN' ? '簽到' : '簽退';
      const welcomeMsg = (action === 'IN' && workerRes.rows.length === 0) ? ' (系統已為您建檔)' : '';
      
      // 🌟【修改 2】：顯示打卡時間與校正提示給員工看！
      const displayTimeStr = `${String(finalHour).padStart(2, '0')}:${String(finalMin).padStart(2, '0')}`;
      const adjustMsg = isAdjusted 
        ? `｜🕒 系統已將時間自動校正為 ${displayTimeStr}！` 
        : `｜🕒 您的實際打卡時間為 ${displayTimeStr}`;

      return res.json({ 
          success: true, 
          message: `✅ ${worker.name}，${actionText}成功！${welcomeMsg} ${adjustMsg}`, 
          distance: distance 
      });
    }

  } catch (err) {
    // 🚨 這裡就是剛剛不小心被刪掉的 catch 區塊！
    console.error('打卡 API 錯誤:', err);
    res.status(500).json({ success: false, message: '伺服器內部錯誤' });
  }

}); */


/* // 1. 獲取打卡紀錄 (已更新：支援組別、工作紀錄與同列合併)
app.post('/api/records', async (req, res) => {
  try {
    const { password } = req.body;
    const sysRes = await pool.query('SELECT admin_password FROM SystemSettings LIMIT 1');
    // 🌟【修改】使用 bcrypt 進行安全比對
    const isValid = await bcrypt.compare(password, sysRes.rows[0].admin_password);
    if (!isValid) return res.status(403).json({ success: false, message: '密碼錯誤' });

// 🚨 這裡有更新：多選了 sub_group 和 special_status
    const result = await pool.query(`
      SELECT CheckIns.id, CheckIns.worker_id, Workers.name AS worker_name, Workers.worker_group, Workers.sub_group,
             Locations.location_name, CheckIns.action, CheckIns.timestamp, CheckIns.work_log, CheckIns.special_status
      FROM CheckIns 
      JOIN Workers ON CheckIns.worker_id = Workers.id 
      JOIN Locations ON CheckIns.location_id = Locations.id
      -- 🌟【新增限制】：只抓取最近 7 天的資料，並且最多只回傳 500 筆！
      WHERE CheckIns.timestamp >= NOW() - INTERVAL '7 days'
      ORDER BY CheckIns.timestamp DESC
      LIMIT 500
    `);
    res.json({ success: true, records: result.rows });
  } catch (err) { res.status(500).json({ success: false }); }
});


// --- 後台管理專區 API ---



// 2. 獲取目前營業時間 (需密碼)
app.post('/api/settings', async (req, res) => {
  try { // 🌟 裝上安全氣囊
    const password = req.body.password || ""; // 🛡️ 防呆：如果沒傳密碼，預設給空字串，防止 bcrypt 崩潰
    const sysRes = await pool.query('SELECT * FROM SystemSettings LIMIT 1');
    
    const isValid = await bcrypt.compare(password, sysRes.rows[0].admin_password);
    if (!isValid) return res.status(403).json({ success: false, message: '密碼錯誤' });
    
    res.json({ success: true, open_time: sysRes.rows[0].open_time, close_time: sysRes.rows[0].close_time });
  } catch (err) {
    console.error('登入 API 發生崩潰:', err);
    res.status(500).json({ success: false, message: '伺服器發生異常' });
  }
});

// 3. 儲存新的營業時間 (需密碼)
app.put('/api/settings', async (req, res) => {
  try { // 🌟 裝上安全氣囊
    const password = req.body.password || "";
    const { open_time, close_time } = req.body;
    const sysRes = await pool.query('SELECT admin_password FROM SystemSettings LIMIT 1');
    
    const isValid = await bcrypt.compare(password, sysRes.rows[0].admin_password);
    if (!isValid) return res.status(403).json({ success: false, message: '密碼錯誤' });

    await pool.query('UPDATE SystemSettings SET open_time = $1, close_time = $2', [open_time, close_time]);
    res.json({ success: true, message: '時間設定已更新！' });
  } catch (err) {
    console.error('儲存時間 API 發生崩潰:', err);
    res.status(500).json({ success: false, message: '伺服器發生異常' });
  }
});

// 4. 匯出 CSV 報表 (支援日期區間過濾與工作紀錄)
app.post('/api/export', async (req, res) => {
  try {
    // 【新增】接收前端傳來的 startDate 與 endDate
    const { password, startDate, endDate } = req.body;
    const sysRes = await pool.query('SELECT admin_password FROM SystemSettings LIMIT 1');
    // 🌟【修改】使用 bcrypt 進行安全比對
    const isValid = await bcrypt.compare(password, sysRes.rows[0].admin_password);
    if (!isValid) return res.status(403).json({ success: false, message: '密碼錯誤' });

    // 【新增】動態組裝 SQL，如果前端有傳日期，就加入 WHERE 條件
    let queryStr = `
      SELECT CheckIns.worker_id, Workers.name AS worker_name, Workers.phone_last4, Workers.worker_group, Workers.sub_group,
             Locations.location_name, CheckIns.action, CheckIns.timestamp, CheckIns.work_log, CheckIns.special_status
      FROM CheckIns 
      JOIN Workers ON CheckIns.worker_id = Workers.id 
      JOIN Locations ON CheckIns.location_id = Locations.id
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 1;

    // 將台灣時間的日期字串轉為查詢範圍
    if (startDate) {
      queryStr += ` AND CheckIns.timestamp AT TIME ZONE 'Asia/Taipei' >= $${paramCount}::timestamp`;
      params.push(`${startDate} 00:00:00`);
      paramCount++;
    }
    if (endDate) {
      queryStr += ` AND CheckIns.timestamp AT TIME ZONE 'Asia/Taipei' <= $${paramCount}::timestamp`;
      params.push(`${endDate} 23:59:59`);
      paramCount++;
    }

    queryStr += ` ORDER BY CheckIns.timestamp ASC`;

    // 執行查詢
    const result = await pool.query(queryStr, params);

    const dailyData = {};

result.rows.forEach(r => {
      const dateObj = new Date(r.timestamp);
      const dateStr = dateObj.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' }); 
      const timeStr = dateObj.toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
      
      const key = `${r.worker_id}_${dateStr}`; 

      if (!dailyData[key]) {
        dailyData[key] = {
          group: r.worker_group || '未分類',
          sub_group: r.sub_group || '未分類',
          // 2. 【修改拼接邏輯】：將姓名與四碼連接 (例如：王小明(1234))
          name: `${r.worker_name}${r.phone_last4}`,
          date: dateStr,
          location: r.location_name,
          inTimeObj: null,
          outTimeObj: null,
          inTimeStr: '未簽到',
          outTimeStr: '未簽退',
          totalHours: 0,
          bento: '' // 🟢 【修改】將 workLog 改名為 bento
        };
      }

      if (r.action === 'IN' && !dailyData[key].inTimeObj) {
        dailyData[key].inTimeObj = dateObj;
        dailyData[key].inTimeStr = timeStr;
        // 🟢 【關鍵修改】：因為便當是跟著「上班 (IN)」一起存的，所以要在這裡抓 work_log
        if (r.work_log) dailyData[key].bento = r.work_log; 
      } 
      else if (r.action === 'OUT') {
        dailyData[key].outTimeObj = dateObj;
        dailyData[key].outTimeStr = timeStr;
        // 🔴 這裡把原本抓 OUT work_log 的邏輯刪除，因為用不到了
      }
    });
    
    // 🌟【新增】：CSV 防毒過濾器 (防止 Excel 自動執行惡意公式)
    function safeCsvField(val) {
      const str = String(val || '');
      // 如果文字開頭是 =、+、-、@，Excel 會把它當公式。我們在前面偷偷加一個單引號把它變成純文字！
      const escaped = str.startsWith('=') || str.startsWith('+') || str.startsWith('-') || str.startsWith('@')
        ? `'${str}` : str;
      // 用雙引號把整個欄位包起來，並處理裡面本來就有的雙引號
      return `"${escaped.replace(/"/g, '""')}"`;
    }

    // 🟢 【修改】欄位順序的標題：把「工作紀錄」改成「便當選擇」
    let csvContent = '\uFEFF組別,副組別,姓名,日期,場地,簽到時間,簽退時間,總工時(小時),便當選擇,特殊狀況\n';
    
    Object.values(dailyData).forEach(d => {
      d.totalHours = ""; 
      if (d.inTimeObj && d.outTimeObj) {
        const diffMs = d.outTimeObj - d.inTimeObj;
        const totalMins = Math.floor(diffMs / (1000 * 60));
        const hours = Math.floor(totalMins / 60);
        const mins = totalMins % 60;
        d.totalHours = `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
      }
      
      csvContent += `${safeCsvField(d.group)},${safeCsvField(d.sub_group)},${safeCsvField(d.name)},${safeCsvField(d.date)},${safeCsvField(d.location)},${safeCsvField(d.inTimeStr)},${safeCsvField(d.outTimeStr)},${safeCsvField(d.totalHours)},${safeCsvField(d.bento)},${safeCsvField(d.specialStatus)}\n`;
    });

    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.send(csvContent);

  } catch (err) {
    console.error('匯出報表失敗:', err);
    res.status(500).json({ success: false });
  }
});

// 5. 匯入每日班表
app.post('/api/roster', async (req, res) => {
  try {
    const { password, targetDate, rosterData } = req.body;
    const sysRes = await pool.query('SELECT admin_password FROM SystemSettings LIMIT 1');
    // 🌟【修改】使用 bcrypt 進行安全比對
    const isValid = await bcrypt.compare(password, sysRes.rows[0].admin_password);
    if (!isValid) return res.status(403).json({ success: false, message: '密碼錯誤' });

    // 先把那一天的舊班表清空 (覆蓋更新的概念)
    await pool.query('DELETE FROM DailyRoster WHERE work_date = $1', [targetDate]);

    // 把前端傳來的名單，一筆一筆寫入資料庫
    if (rosterData && rosterData.length > 0) {
      // 🌟【升級】將資料打包成陣列，準備進行「批次寫入」
      const names = rosterData.map(w => w.name);
      const phones = rosterData.map(w => w.phone_last4);
      const dates = rosterData.map(() => targetDate);

      // 🌟 利用 PostgreSQL 的 unnest 功能，一次把幾百筆資料瞬間倒進去！
      await pool.query(`
        INSERT INTO DailyRoster (name, phone_last4, work_date)
        SELECT * FROM unnest($1::varchar[], $2::varchar[], $3::date[])
      `, [names, phones, dates]);
    }
    res.json({ success: true, message: `成功更新 ${rosterData.length} 筆排班資料！` });
  } catch (err) {
    console.error('匯入班表失敗:', err);
    res.status(500).json({ success: false, message: '伺服器錯誤' });
  }
});

// 6. 獲取特定日期的班表與「未到班」名單
app.post('/api/roster/list', async (req, res) => {
  try {
    const { password, targetDate } = req.body;
    const sysRes = await pool.query('SELECT admin_password FROM SystemSettings LIMIT 1');
    // 🌟【修改】使用 bcrypt 進行安全比對
    const isValid = await bcrypt.compare(password, sysRes.rows[0].admin_password);
    if (!isValid) return res.status(403).json({ success: false, message: '密碼錯誤' });

    // 1. 抓取當日白名單
    const rosterRes = await pool.query(
      'SELECT name, phone_last4 FROM DailyRoster WHERE work_date = $1',
      [targetDate]
    );
    const rosterList = rosterRes.rows;

    // 2. 抓取當日「已簽到 (IN)」的員工手機尾碼
    const checkinRes = await pool.query(
      `SELECT w.phone_last4 
       FROM CheckIns c 
       JOIN Workers w ON c.worker_id = w.id 
       WHERE c.action = 'IN' 
         AND c.timestamp AT TIME ZONE 'Asia/Taipei' >= $1::timestamp
         AND c.timestamp AT TIME ZONE 'Asia/Taipei' <= $2::timestamp`,
      [`${targetDate} 00:00:00`, `${targetDate} 23:59:59`]
    );
    // 把有簽到的人的手機尾碼抽出來變成一個陣列 (例如: ['1234', '5678'])
    const checkedInPhones = checkinRes.rows.map(r => r.phone_last4);

    // 3. 智慧比對：過濾出「在白名單裡，但沒有簽到」的人
    const absentList = rosterList.filter(r => !checkedInPhones.includes(r.phone_last4));

    res.json({ success: true, roster: rosterList, absent: absentList });
  } catch (err) {
    console.error('獲取班表清單失敗:', err);
    res.status(500).json({ success: false });
  }
}); */


app.listen(PORT, () => {
  console.log(`🚀 後端伺服器已啟動：http://localhost:${PORT}`);
});