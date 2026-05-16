// controllers/adminController.js
const pool = require('../database');
const bcrypt = require('bcrypt');

// 🌟【新增】：共用的密碼驗證中介軟體 (警衛)
const requireAdminPassword = async (req, res, next) => {
  try {
    const password = req.body.password || "";
    const sysRes = await pool.query('SELECT admin_password FROM SystemSettings LIMIT 1');
    const isValid = await bcrypt.compare(password, sysRes.rows[0].admin_password);
    
    if (!isValid) return res.status(403).json({ success: false, message: '密碼錯誤' });
    
    next(); // 密碼正確，放行給下一個核心功能！
  } catch (err) {
    console.error('驗證失敗:', err);
    res.status(500).json({ success: false, message: '伺服器異常' });
  }
};

// ----------------------------------------------------
// 以下核心功能，不再需要自己檢查密碼了！代碼大瘦身！
// ----------------------------------------------------

// 1. 獲取打卡紀錄
const getRecords = async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT CheckIns.id, CheckIns.worker_id, Workers.name AS worker_name, Workers.worker_group, Workers.sub_group,
             Locations.location_name, CheckIns.action, CheckIns.timestamp, CheckIns.work_log, CheckIns.special_status
      FROM CheckIns JOIN Workers ON CheckIns.worker_id = Workers.id JOIN Locations ON CheckIns.location_id = Locations.id
      WHERE CheckIns.timestamp >= NOW() - INTERVAL '7 days'
      ORDER BY CheckIns.timestamp DESC LIMIT 500
    `);
    res.json({ success: true, records: result.rows });
  } catch (err) { res.status(500).json({ success: false }); }
};

// 2. 獲取營業時間
const getSettings = async (req, res) => {
  try {
    const sysRes = await pool.query('SELECT open_time, close_time FROM SystemSettings LIMIT 1');
    res.json({ success: true, open_time: sysRes.rows[0].open_time, close_time: sysRes.rows[0].close_time });
  } catch (err) { res.status(500).json({ success: false, message: '伺服器異常' }); }
};

// 3. 儲存營業時間
const updateSettings = async (req, res) => {
  try {
    const { open_time, close_time } = req.body;
    await pool.query('UPDATE SystemSettings SET open_time = $1, close_time = $2', [open_time, close_time]);
    res.json({ success: true, message: '時間設定已更新！' });
  } catch (err) { res.status(500).json({ success: false, message: '伺服器異常' }); }
};

// 4. 匯出 CSV 報表
const exportCsv = async (req, res) => {
  try {
    const { startDate, endDate } = req.body;
    let queryStr = `
      SELECT CheckIns.worker_id, Workers.name AS worker_name, Workers.phone_last4, Workers.worker_group, Workers.sub_group,
             Locations.location_name, CheckIns.action, CheckIns.timestamp, CheckIns.work_log, CheckIns.special_status
      FROM CheckIns JOIN Workers ON CheckIns.worker_id = Workers.id JOIN Locations ON CheckIns.location_id = Locations.id
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 1;

    if (startDate) { queryStr += ` AND CheckIns.timestamp AT TIME ZONE 'Asia/Taipei' >= $${paramCount}::timestamp`; params.push(`${startDate} 00:00:00`); paramCount++; }
    if (endDate) { queryStr += ` AND CheckIns.timestamp AT TIME ZONE 'Asia/Taipei' <= $${paramCount}::timestamp`; params.push(`${endDate} 23:59:59`); paramCount++; }
    queryStr += ` ORDER BY CheckIns.timestamp ASC`;

    const result = await pool.query(queryStr, params);
    const dailyData = {};

    result.rows.forEach(r => {
      const dateObj = new Date(r.timestamp);
      const dateStr = dateObj.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' }); 
      const timeStr = dateObj.toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
      const key = `${r.worker_id}_${dateStr}`; 

      if (!dailyData[key]) {
        dailyData[key] = {
          group: r.worker_group || '未分類', sub_group: r.sub_group || '未分類',
          name: `${r.worker_name}(${r.phone_last4})`, date: dateStr, location: r.location_name,
          inTimeObj: null, outTimeObj: null, inTimeStr: '未簽到', outTimeStr: '未簽退', totalHours: 0, bento: ''
        };
      }
      if (r.action === 'IN' && !dailyData[key].inTimeObj) {
        dailyData[key].inTimeObj = dateObj; dailyData[key].inTimeStr = timeStr;
        if (r.work_log) dailyData[key].bento = r.work_log; 
      } else if (r.action === 'OUT') {
        dailyData[key].outTimeObj = dateObj; dailyData[key].outTimeStr = timeStr;
      }
    });

    function safeCsvField(val) {
      const str = String(val || '');
      const escaped = str.startsWith('=') || str.startsWith('+') || str.startsWith('-') || str.startsWith('@') ? `'${str}` : str;
      return `"${escaped.replace(/"/g, '""')}"`;
    }

    let csvContent = '\uFEFF組別,副組別,姓名,日期,場地,簽到時間,簽退時間,總工時(小時),便當選擇,特殊狀況\n';
    Object.values(dailyData).forEach(d => {
      d.totalHours = ""; 
      if (d.inTimeObj && d.outTimeObj) {
        const diffMs = d.outTimeObj - d.inTimeObj;
        const totalMins = Math.floor(diffMs / (1000 * 60));
        d.totalHours = `${String(Math.floor(totalMins / 60)).padStart(2, '0')}:${String(totalMins % 60).padStart(2, '0')}`;
      }
      csvContent += `${safeCsvField(d.group)},${safeCsvField(d.sub_group)},${safeCsvField(d.name)},${safeCsvField(d.date)},${safeCsvField(d.location)},${safeCsvField(d.inTimeStr)},${safeCsvField(d.outTimeStr)},${safeCsvField(d.totalHours)},${safeCsvField(d.bento)},${safeCsvField(d.specialStatus)}\n`;
    });

    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.send(csvContent);
  } catch (err) { res.status(500).json({ success: false }); }
};

// 5. 匯入班表
const importRoster = async (req, res) => {
  try {
    const { targetDate, rosterData } = req.body;
    await pool.query('DELETE FROM DailyRoster WHERE work_date = $1', [targetDate]);
    if (rosterData && rosterData.length > 0) {
      const names = rosterData.map(w => w.name);
      const phones = rosterData.map(w => w.phone_last4);
      const dates = rosterData.map(() => targetDate);
      await pool.query(`INSERT INTO DailyRoster (name, phone_last4, work_date) SELECT * FROM unnest($1::varchar[], $2::varchar[], $3::date[])`, [names, phones, dates]);
    }
    res.json({ success: true, message: `成功更新 ${rosterData.length} 筆排班資料！` });
  } catch (err) { res.status(500).json({ success: false, message: '伺服器錯誤' }); }
};

// 6. 獲取班表清單
const getRosterList = async (req, res) => {
  try {
    const { targetDate } = req.body;
    const rosterRes = await pool.query('SELECT name, phone_last4 FROM DailyRoster WHERE work_date = $1', [targetDate]);
    const checkinRes = await pool.query(
      `SELECT w.phone_last4 FROM CheckIns c JOIN Workers w ON c.worker_id = w.id 
       WHERE c.action = 'IN' AND c.timestamp AT TIME ZONE 'Asia/Taipei' >= $1::timestamp AND c.timestamp AT TIME ZONE 'Asia/Taipei' <= $2::timestamp`,
      [`${targetDate} 00:00:00`, `${targetDate} 23:59:59`]
    );
    const checkedInPhones = checkinRes.rows.map(r => r.phone_last4);
    const absentList = rosterRes.rows.filter(r => !checkedInPhones.includes(r.phone_last4));

    res.json({ success: true, roster: rosterRes.rows, absent: absentList });
  } catch (err) { res.status(500).json({ success: false }); }
};

// 🌟 將警衛與六個功能統一匯出
module.exports = { requireAdminPassword, getRecords, getSettings, updateSettings, exportCsv, importRoster, getRosterList };