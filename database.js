// database.js
const { Pool } = require('pg');

// 貼上您在 Neon 複製的 Connection String (記得保留引號)
const connectionString = 'postgresql://neondb_owner:npg_OK8fraZEe5VF@ep-steep-surf-ao0jzbgi.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require';

const pool = new Pool({
  connectionString: connectionString,
  ssl: { rejectUnauthorized: false } // 雲端連線安全必備設定
});

pool.connect((err) => {
  if (err) console.error('❌ 資料庫連線失敗：', err.stack);
  else console.log('✅ 成功連線至 Neon 雲端 PostgreSQL 資料庫！');
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