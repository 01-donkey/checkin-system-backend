// database.js
const sqlite3 = require('sqlite3').verbose();

// 連線到 SQLite 資料庫 (如果檔案不存在，會自動在同目錄下建立 database.sqlite)
const db = new sqlite3.Database('./database.sqlite', (err) => {
  if (err) {
    console.error('資料庫連線失敗：', err.message);
  } else {
    console.log('✅ 成功連線至 SQLite 資料庫。');
  }
});

// 初始化資料表 (Schema)
db.serialize(() => {
  // 1. 人員表 (Workers)
  db.run(`CREATE TABLE IF NOT EXISTS Workers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone_last4 TEXT NOT NULL
  )`);

  // 2. 場地表 (Locations)
  db.run(`CREATE TABLE IF NOT EXISTS Locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    location_name TEXT NOT NULL,
    center_lat REAL NOT NULL,
    center_lng REAL NOT NULL,
    radius_meters INTEGER NOT NULL
  )`);

  // 3. 打卡紀錄表 (CheckIns)
  db.run(`CREATE TABLE IF NOT EXISTS CheckIns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    worker_id INTEGER,
    location_id INTEGER,
    action TEXT CHECK(action IN ('IN', 'OUT')),
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    device_gps_lat REAL,
    device_gps_lng REAL,
    sync_status INTEGER DEFAULT 0
  )`);
});

// 為了方便測試，我們預先塞入「多筆」場地資料與測試員工
db.serialize(() => {
  db.get("SELECT count(*) as count FROM Locations", (err, row) => {
    if (row.count === 0) {
      // 1. 準備插入多筆場地的指令
      const stmtLocation = db.prepare(`INSERT INTO Locations (location_name, center_lat, center_lng, radius_meters) VALUES (?, ?, ?, ?)`);
      
      // 寫入「西岸 SNA」(請替換為真實座標)
      stmtLocation.run('西岸 SNA', 25.033964, 121.564468, 100);
      
      // 寫入「東岸 COSTA」(請替換為真實座標，此處暫用不同座標測試)
      stmtLocation.run('東岸 COSTA', 25.042222, 121.553333, 100); 

      //輔大醫學院 25.03932719948671, 121.43106539424298
      stmtLocation.run('輔大醫學院', 25.03932719948671, 121.43106539424298, 100);
      
      //我家25.07206254918712, 121.46513453409462
      stmtLocation.run('我家', 25.07206254918712, 121.46513453409462, 100);
      
      stmtLocation.finalize();

      // 2. 準備插入多筆測試員工
      const stmtWorker = db.prepare(`INSERT INTO Workers (name, phone_last4) VALUES (?, ?)`);
      stmtWorker.run('阮建鋐', '0909');
      stmtWorker.run('陳可容', '1500'); // 加入另一位名單上的人員方便測試
      stmtWorker.finalize();

      console.log('✅ 已寫入多筆場地與員工測試資料。');
    }
  });
});

module.exports = db;