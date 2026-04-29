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

    // 寫入預設的兩筆場地與兩位員工 (防呆：若已有資料則不重複寫入)
    const locRes = await pool.query("SELECT count(*) FROM Locations");
    if (parseInt(locRes.rows[0].count) === 0) {
      await pool.query(`INSERT INTO Locations (location_name, center_lat, center_lng, radius_meters) VALUES ('西岸 SNA', 25.033964, 121.564468, 100)`);
      await pool.query(`INSERT INTO Locations (location_name, center_lat, center_lng, radius_meters) VALUES ('東岸 COSTA', 25.042222, 121.553333, 100)`);
      await pool.query(`INSERT INTO Locations (location_name, center_lat, center_lng, radius_meters) VALUES ('輔大 醫學院', 25.0720625, 121.465134, 100)`);
      await pool.query(`INSERT INTO Locations (location_name, center_lat, center_lng, radius_meters) VALUES ('我家', 25.0393271, 121.4310653, 100)`);

      await pool.query(`INSERT INTO Workers (name, phone_last4) VALUES ('阮建鋐', '0909')`);
      await pool.query(`INSERT INTO Workers (name, phone_last4) VALUES ('陳可容', '1500')`);
      console.log('✅ 已寫入場地與員工測試資料至雲端資料庫。');
    }
  } catch (err) {
    console.error('初始化資料表失敗：', err);
  }
}

initDB();

module.exports = pool;