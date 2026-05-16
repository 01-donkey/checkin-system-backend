// controllers/qrController.js
const pool = require('../database');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const SECRET_KEY = process.env.SECRET_KEY;

// 🌟 1.【新增】：用密碼換取 Kiosk Token 的專屬 API
const getKioskToken = async (req, res) => {
  try {
    const { password } = req.body;
    // 驗證管理員密碼
    const sysRes = await pool.query('SELECT admin_password FROM SystemSettings LIMIT 1');
    const isValid = await bcrypt.compare(password, sysRes.rows[0].admin_password);
    if (!isValid) return res.status(403).json({ success: false, message: '密碼錯誤' });

    // 產生一個 12 小時效期的 Kiosk Token (無狀態加密設計，伺服器重啟也不會失效)
    const expire = Date.now() + 12 * 60 * 60 * 1000;
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(`kiosk:${expire}`).digest('hex');
    
    // 回傳這把臨時鑰匙
    res.json({ success: true, token: `${expire}.${signature}` });
  } catch (err) {
    res.status(500).json({ success: false, message: '伺服器錯誤' });
  }
};

// 🌟 2.【升級】：支援用 Kiosk Token 產生打卡條碼
const generateQrToken = async (req, res) => {
  try {
    // 接收參數新增了 kioskToken
    const { password, kioskToken, location_id = 1, duration = 90000 } = req.body;

    let isAuthorized = false;

    // 🛡️ 雙通道驗證：有 kioskToken 優先驗證，沒有才驗證傳統密碼
    if (kioskToken) {
      const [expire, signature] = kioskToken.split('.');
      if (Date.now() > parseInt(expire)) {
        return res.status(403).json({ success: false, message: '授權已過期，請重新從後台開啟' });
      }
      const expectedSignature = crypto.createHmac('sha256', SECRET_KEY).update(`kiosk:${expire}`).digest('hex');
      if (signature === expectedSignature) isAuthorized = true;
    } else if (password) {
      const sysRes = await pool.query('SELECT admin_password FROM SystemSettings LIMIT 1');
      isAuthorized = await bcrypt.compare(password, sysRes.rows[0].admin_password);
    }

    if (!isAuthorized) return res.status(403).json({ success: false, message: '無效的請求：驗證失敗' });

    // --- 下面產生條碼的邏輯照舊 ---
    const MAX_DURATION = 24 * 60 * 60 * 1000;
    const safeDuration = Math.min(parseInt(duration), MAX_DURATION);
    const timestamp = Date.now();
    const signature = crypto.createHmac('sha256', SECRET_KEY).update(`${location_id}:${timestamp}:${safeDuration}`).digest('hex');
    
    res.json({ success: true, token: `${timestamp}.${safeDuration}.${signature}`, location_id: location_id });
  } catch (err) {
    console.error('產生 Token 失敗:', err);
    res.status(500).json({ success: false, message: '伺服器錯誤' });
  }
};

// 將兩支 API 匯出
module.exports = { generateQrToken, getKioskToken };