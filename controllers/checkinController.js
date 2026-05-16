// controllers/checkinController.js
const pool = require('../database');
const crypto = require('crypto');
const { getDistanceFromLatLonInM } = require('../utils/helper');
const SECRET_KEY = process.env.SECRET_KEY;

const handleCheckin = async (req, res) => {
  try {
    // 1. 接收前端傳來的參數
    const { name, phone_last4, location_id, action, lat, lng, token, group, sub_group, special_status, bento } = req.body;

    if (!phone_last4 || !location_id || !action || !lat || !lng || !token) {
      return res.status(400).json({ success: false, message: '缺少必要參數' });
    }
    // 只有簽退時，才強制要求組別
    if (action === 'OUT' && !group) {
      return res.status(400).json({ success: false, message: '簽退時請確認是否已選擇組別' });
    }

    // 攔截非營業時間 (獲取標準時間，並計算時間校正)
    const settingRes = await pool.query('SELECT open_time, close_time FROM SystemSettings LIMIT 1');
    const { open_time, close_time } = settingRes.rows[0];
    
    const now = new Date();
    
    // 🌟【升級防護】：一次取得所有時間欄位，避免跨日午夜的錯亂 (Race condition)
    const tpeParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Taipei',
      year: 'numeric', 
      month: '2-digit', 
      day: '2-digit',
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit',
      hour12: false
    }).formatToParts(now);

    // 建立一個小工具函數來抽取快照裡的資料
    const getTpe = (type) => tpeParts.find(p => p.type === type).value;

    const yyyy = getTpe('year');
    const mm = getTpe('month');
    const dd = getTpe('day');
    const ss = getTpe('second');
    
    // 確保午夜 24:00 會被正確轉換為 0
    let tpeHour = parseInt(getTpe('hour'));
    if (tpeHour === 24) tpeHour = 0; 
    
    const tpeMin = parseInt(getTpe('minute'));

    const currentMinutes = tpeHour * 60 + tpeMin;

    const [openH, openM] = open_time.split(':').map(Number);
    const [closeH, closeM] = close_time.split(':').map(Number);
    const openMinutes = openH * 60 + openM;
    const closeMinutes = closeH === 24 ? 24 * 60 : closeH * 60 + closeM;

    // 放寬大門
    if (currentMinutes < openMinutes - 60 || currentMinutes > closeMinutes + 120) {
      return res.status(403).json({ success: false, message: `目前非開放打卡時間！(開放區間：${open_time} 前一小時 ~ ${close_time} 後兩小時)` });
    }

    // 時間校正魔法
    let finalHour = tpeHour;
    let finalMin = tpeMin;
    let isAdjusted = false;

    if (action === 'IN') {
      if (currentMinutes >= openMinutes - 10 && currentMinutes <= openMinutes + 15) {
        finalHour = openH;
        finalMin = openM;
        isAdjusted = true;
      }
    } else if (action === 'OUT') {
      if (currentMinutes >= closeMinutes && currentMinutes <= closeMinutes + 20) {
        finalHour = closeH;
        finalMin = closeM;
        isAdjusted = true;
      }
    }
    const finalSec = isAdjusted ? '00' : ss;
    // 修正 24:00 的邊界情況
    let adjustedHour = finalHour;
    let adjustedDate = `${yyyy}-${mm}-${dd}`;

    if (finalHour === 24) {
      // 24:00 其實是隔天的 00:00
      const tomorrow = new Date(Date.UTC(
        parseInt(yyyy), parseInt(mm) - 1, parseInt(dd) + 1
      ));
      adjustedDate = tomorrow.toISOString().slice(0, 10);
      adjustedHour = 0;
    }
    const dbDateObj = new Date(
      `${adjustedDate}T${String(adjustedHour).padStart(2, '0')}:${String(finalMin).padStart(2, '0')}:${finalSec}+08:00`
    );
    
    // 驗證 Token
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
      if (group) {
        await pool.query('UPDATE Workers SET worker_group = $1, sub_group = $2 WHERE id = $3', [group, sub_group || null, worker.id]);
      }
    }

    // 防手抖防呆
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

    // 嚴格排班白名單檢查
    const rosterCheck = await pool.query(
      `SELECT count(*) FROM DailyRoster WHERE work_date = CURRENT_DATE AT TIME ZONE 'Asia/Taipei'`
    );
    if (parseInt(rosterCheck.rows[0].count) > 0) {
      const myRoster = await pool.query(
        `SELECT id FROM DailyRoster 
         WHERE phone_last4 = $1 AND work_date = CURRENT_DATE AT TIME ZONE 'Asia/Taipei'`,
        [phone_last4]
      );
      if (myRoster.rows.length === 0) {
        return res.status(403).json({ success: false, message: `🛑 拒絕打卡：您今天沒有排班喔！請與管理員確認。` });
      }
    }

    // 嚴格禁止重複打卡邏輯
    const todayRecordRes = await pool.query(
      `SELECT id, timestamp FROM CheckIns 
       WHERE worker_id = $1 AND location_id = $2 AND action = $3 
       AND timestamp >= CURRENT_DATE AT TIME ZONE 'Asia/Taipei'
       AND timestamp < (CURRENT_DATE + 1) AT TIME ZONE 'Asia/Taipei'
       LIMIT 1`,
      [worker.id, location_id, action]
    );

    if (todayRecordRes.rows.length > 0) {
      const oldTime = new Date(todayRecordRes.rows[0].timestamp).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
      const actionText = action === 'IN' ? '簽到' : '簽退';
      return res.status(403).json({ success: false, message: `重複打卡：您今天在 ${oldTime} 已經完成過「${actionText}」了！` });
    } else {
      const logToSave = action === 'IN' ? bento : null;
      await pool.query(
        'INSERT INTO CheckIns (worker_id, location_id, action, device_gps_lat, device_gps_lng, work_log, timestamp) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [worker.id, location_id, action, lat, lng, logToSave, dbDateObj]
      );
      
      const actionText = action === 'IN' ? '簽到' : '簽退';
      const welcomeMsg = (action === 'IN' && workerRes.rows.length === 0) ? ' (系統已為您建檔)' : '';
      const displayTimeStr = `${String(finalHour).padStart(2, '0')}:${String(finalMin).padStart(2, '0')}`;
      const adjustMsg = isAdjusted ? `｜🕒 系統已將時間自動校正為 ${displayTimeStr}！` : `｜🕒 您的實際打卡時間為 ${displayTimeStr}`;

      return res.json({ success: true, message: `✅ ${worker.name}，${actionText}成功！${welcomeMsg} ${adjustMsg}`, distance: distance });
    }

  } catch (err) {
    console.error('打卡 API 錯誤:', err);
    res.status(500).json({ success: false, message: '伺服器內部錯誤' });
  }
};

module.exports = { handleCheckin };