// database.js
const { Pool } = require('pg');
require('dotenv').config(); // 🌟【新增】這行用來啟動保險箱

// 建立本地端連線池 (建議使用物件方式，比較清楚好改)
const pool = new Pool({
  user: 'postgres',        // 您的本地 PostgreSQL 帳號 (通常預設是 postgres)
  host: 'localhost',       // 本地主機位址
  database: 'polymathtour_checkin', // 🚨 請填入您在本地端建立的「資料庫名稱」
  password: process.env.DB_PASSWORD, // 🌟【新增】從 .env 檔案讀取密碼，確保安全性
  port: 5432,              // PostgreSQL 預設通訊埠 (通常不用改)
  // ⚠️ 注意：本地端連線通常不需要 SSL，所以把雲端的 ssl 設定拿掉了
  // 🌟【新增】：連線池保護機制
  max: 10,                   // 同時最多允許 10 條連線 (其他的會在外面排隊，不會讓 DB 當機)
  idleTimeoutMillis: 30000,  // 如果連線閒置超過 30 秒就自動關閉，節省資源
  connectionTimeoutMillis: 2000, // 如果 2 秒連不上 DB 就直接報錯，避免卡死
});

pool.connect((err) => {
  if (err) {
    console.error('❌ 本地資料庫連線失敗：', err.stack);
  } else {
    console.log('✅ 成功連線至「本地端」PostgreSQL 資料庫！');
  }
});


// 初始化資料表 (Postgres 語法：用 SERIAL 取代 AUTOINCREMENT)
async function initDB() {
  try {
    // 1. 人員表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS Workers (
        id SERIAL PRIMARY KEY,
        name VARCHAR(50) NOT NULL,
        phone_last4 VARCHAR(4) NOT NULL
      );
    `);

    // 2. 場地表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS Locations (
        id SERIAL PRIMARY KEY,
        location_name VARCHAR(100) NOT NULL,
        center_lat REAL NOT NULL,
        center_lng REAL NOT NULL,
        radius_meters INTEGER NOT NULL
      );
    `);

    // 3. 打卡紀錄表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS CheckIns (
        id SERIAL PRIMARY KEY,
        worker_id INTEGER,
        location_id INTEGER,
        action VARCHAR(10) CHECK(action IN ('IN', 'OUT')),
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        device_gps_lat REAL,
        device_gps_lng REAL
      );
    `);

    // 3.5 每日班表 (白名單)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS DailyRoster (
        id SERIAL PRIMARY KEY,
        name VARCHAR(50),
        phone_last4 VARCHAR(4) NOT NULL,
        work_date DATE NOT NULL
      );
    `);
    
    await pool.query(`ALTER TABLE Workers ADD COLUMN IF NOT EXISTS worker_group VARCHAR(50);`);
    await pool.query(`ALTER TABLE CheckIns ADD COLUMN IF NOT EXISTS work_log TEXT;`);

        // database.js
    // 在原本的 ALTER TABLE Workers... 下方加入
    await pool.query(`ALTER TABLE Workers ADD COLUMN IF NOT EXISTS sub_group VARCHAR(50);`);
    await pool.query(`ALTER TABLE CheckIns ADD COLUMN IF NOT EXISTS special_status TEXT;`);

    // 新增設備綁定碼欄位
    await pool.query(`ALTER TABLE Workers ADD COLUMN IF NOT EXISTS device_uuid VARCHAR(100);`);

    // 4. 系統設定表 (包含密碼與營業時間)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS SystemSettings (
        id SERIAL PRIMARY KEY,
        admin_password VARCHAR(255) NOT NULL,
        open_time VARCHAR(5) NOT NULL,
        close_time VARCHAR(5) NOT NULL
      );
    `);

// 檢查系統設定表是不是空的，如果是空的就塞入預設值
    const sysRes = await pool.query('SELECT count(*) FROM SystemSettings');
    if (parseInt(sysRes.rows[0].count) === 0) {
      const bcrypt = require('bcrypt'); // 🌟【新增】引入加密套件
      const hashedPwd = await bcrypt.hash('admin123', 10); // 🌟【新增】把 admin123 打碎加密
      
      await pool.query(`
        INSERT INTO SystemSettings (admin_password, open_time, close_time) 
        VALUES ($1, '00:00', '24:00')
      `, [hashedPwd]);
      console.log('✅ 預設系統設定已自動建立！(預設後台登入密碼: admin123)');
    }

    // 🌟【新增】建立資料庫索引 (大幅提升打卡與後台查詢速度)
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_workers_phone ON Workers(phone_last4);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_checkins_worker_ts ON CheckIns(worker_id, timestamp DESC);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_checkins_ts ON CheckIns(timestamp);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_daily_roster_date ON DailyRoster(work_date);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_daily_roster_phone_date ON DailyRoster(phone_last4, work_date);`);

// --- 【智慧同步地點資料】開始 ---
    // 1. 在這裡定義您「最新」的地點與經緯度設定
    const targetLocations = [
      { name: '西岸 SNA', lat: 25.135038, lng: 121.740989, radius: 100 },
      { name: '東岸 COSTA', lat: 25.042222, lng: 121.553333, radius: 100 }
    ];

    // 2. 遍歷檢查並同步到資料庫
    for (const loc of targetLocations) {
      // 檢查這個地點名稱是否已經存在於資料庫中
      const checkRes = await pool.query(
        "SELECT id FROM Locations WHERE location_name = $1", 
        [loc.name]
      );
      
      if (checkRes.rows.length > 0) {
        // [狀況 A] 如果地點已存在 -> 無條件「更新」成最新的經緯度與半徑
        await pool.query(
          "UPDATE Locations SET center_lat = $1, center_lng = $2, radius_meters = $3 WHERE location_name = $4",
          [loc.lat, loc.lng, loc.radius, loc.name]
        );
      } else {
        // [狀況 B] 如果地點不存在 -> 執行「新增」
        await pool.query(
          "INSERT INTO Locations (location_name, center_lat, center_lng, radius_meters) VALUES ($1, $2, $3, $4)",
          [loc.name, loc.lat, loc.lng, loc.radius]
        );
      }
    }
    console.log('✅ 地點資料同步完成！已確保資料庫與程式碼設定完全一致。');
    // --- 【智慧同步地點資料】結束 ---

  } catch (err) {
    console.error('初始化資料表失敗：', err);
  }
}

initDB();

module.exports = pool;