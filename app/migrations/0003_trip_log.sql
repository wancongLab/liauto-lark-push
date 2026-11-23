-- D-076：行程日志（行程小结卡 + 线路图的数据底座）
-- 以前行程只在推卡时算完就丢，无法回看/重画线路，这里落库。
CREATE TABLE IF NOT EXISTS trip_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  vin           TEXT NOT NULL,
  started_at    TEXT NOT NULL,        -- Asia/Shanghai "YYYY-MM-DD HH:MM:SS"
  ended_at      TEXT,                 -- 结束时刻（冗余，便于按天过滤）
  distance_km   REAL,                 -- 车机总里程增量
  duration_min  INTEGER,
  elec_km       REAL,                 -- ΔcdMileage（准确）
  engine_km     REAL,                 -- 里程 − 纯电（估算）
  ad_km         REAL,                 -- ΔadMileage（智驾）
  battery_from  INTEGER,
  battery_to    INTEGER,
  start_loc     TEXT,                 -- 围栏名或坐标（不含精确门牌）
  end_loc       TEXT,
  start_lat     REAL,                 -- WGS-84
  start_lon     REAL,
  end_lat       REAL,
  end_lon       REAL,
  route_points  TEXT,                 -- JSON [[lon,lat],...]  GCJ-02（纠偏后，面板直接画）
  route_km      REAL,                 -- 高德纠偏里程（与车机里程互校）
  route_source  TEXT,                 -- grasp | raw | null
  route_error   TEXT,                 -- 建线失败的简短原因（便于排查，不阻塞推送）
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trip_log_uniq ON trip_log(vin, started_at);
CREATE INDEX IF NOT EXISTS idx_trip_log_time ON trip_log(vin, started_at DESC);
