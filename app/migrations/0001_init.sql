-- 理想汽车 × 飞书 · 账本 schema
-- 命名约定：表名复数、字段 snake_case、时间统一 UTC+8 字符串（ISO-like）

-- ── 车辆信息（一次性获取后永久缓存，见 D-048：日常运行禁止调 saos_vehicle）──
CREATE TABLE IF NOT EXISTS vehicle (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  vin           TEXT NOT NULL UNIQUE,
  spu           TEXT,
  series_no     TEXT,
  model_no      TEXT,
  nickname      TEXT,
  plate_no      TEXT,
  seat_count    INTEGER,
  vehicle_type  TEXT,          -- owned / authorized ...
  role_id       INTEGER,
  energy_type   TEXT,          -- 'erev' 增程 / 'bev' 纯电
  raw_json      TEXT,          -- saos_vehicle 原始条目
  updated_at    TEXT NOT NULL
);

-- ── 时序明细：每次轮询的信号快照 ──
CREATE TABLE IF NOT EXISTS signal_sample (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  vin         TEXT NOT NULL,
  sampled_at  TEXT NOT NULL,            -- YYYY-MM-DD HH:MM:SS
  battery     REAL,                     -- SOC %
  range_km    REAL,                     -- CLTC 续航
  odometer_km REAL,                     -- 总里程
  speed       REAL,
  indoor_temp REAL,
  outdoor_temp REAL,
  charging    INTEGER,                  -- 0/1 是否充电中
  charge_status TEXT,
  travel_status INTEGER,
  trip_total_json TEXT,                 -- 车机行程表原始 JSON（含智驾里程等 36 字段）
  payload     TEXT NOT NULL,            -- 本次全部信号（JSON）
  UNIQUE (vin, sampled_at)
);
CREATE INDEX IF NOT EXISTS idx_signal_time ON signal_sample (vin, sampled_at DESC);

-- ── 日汇总（每天一条，来自 travel/daily/aggregate 单日调用，见 D-044）──
CREATE TABLE IF NOT EXISTS daily_stat (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  vin           TEXT NOT NULL,
  stat_date     TEXT NOT NULL,          -- YYYY-MM-DD
  travel_km     REAL DEFAULT 0,          -- 总里程
  elec_km       REAL DEFAULT 0,          -- 纯电里程
  hybrid_km     REAL DEFAULT 0,          -- 发动机/增程里程
  elec_kwh      REAL DEFAULT 0,          -- 电量
  fuel_l        REAL DEFAULT 0,          -- 油耗
  avg_elec_kwh_per_100km REAL,
  avg_fuel_l_per_100km   REAL,
  ad_km         REAL DEFAULT 0,          -- 智驾里程（当日增量）
  noa_km        REAL DEFAULT 0,
  charge_kwh    REAL DEFAULT 0,          -- 当日充电量
  charge_times  INTEGER DEFAULT 0,
  cost_cny      REAL DEFAULT 0,          -- 电费（按本地电价）
  fuel_cost_cny REAL DEFAULT 0,         -- 油费
  source        TEXT,                   -- travel / manual
  updated_at    TEXT NOT NULL,
  UNIQUE (vin, stat_date)
);

-- ── 充电会话（chargeRecords 明细；实测只有 4 个字段，见 D-046）──
CREATE TABLE IF NOT EXISTS charge_session (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  vin            TEXT NOT NULL,
  session_key    TEXT NOT NULL,         -- startTime+type 去重键
  started_at     TEXT NOT NULL,         -- YYYY-MM-DD HH:MM:SS
  ended_at       TEXT,                  -- 由 VSS 轮询捕捉（charge_status 转完成）
  duration_min   REAL,
  capacity_kwh   REAL,
  charging_type  INTEGER,               -- 1 DC / 2 AC / 3 5C / 4 理想超充
  avg_power_kw   REAL,
  cost_cny       REAL,
  price_per_kwh  REAL,
  station_name   TEXT,                  -- 理想不提供，保留自填
  confirmed      INTEGER DEFAULT 0,
  created_at     TEXT NOT NULL,
  UNIQUE (vin, session_key)
);
CREATE INDEX IF NOT EXISTS idx_charge_start ON charge_session (vin, started_at DESC);

-- ── 电价策略（默认电价 + 账单真实单价，按生效时间轴）──
CREATE TABLE IF NOT EXISTS price_rule (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope       TEXT NOT NULL,            -- default / receipt
  price_cny   REAL NOT NULL,           -- 元/度
  effective_from TEXT NOT NULL,
  effective_to   TEXT,
  source      TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL
);

-- ── 充电账单（OCR / 手填 → 确认后入账）──
CREATE TABLE IF NOT EXISTS receipt (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  vin          TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  kwh          REAL,
  amount_cny   REAL,
  price_cny    REAL,
  paid_at      TEXT,
  station_name TEXT,
  raw_text     TEXT,
  confirmed    INTEGER DEFAULT 0,
  matched_session_id INTEGER,
  created_at   TEXT NOT NULL
);

-- ── 推送账本（幂等：同一事件不重复推）──
CREATE TABLE IF NOT EXISTS push_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  vin         TEXT NOT NULL,
  event_key   TEXT NOT NULL,            -- 如 daily:2026-10-26 / charge:start:1712345
  channel     TEXT NOT NULL,            -- feishu / web
  payload     TEXT,
  sent_at     TEXT NOT NULL,
  UNIQUE (vin, event_key, channel)
);
CREATE INDEX IF NOT EXISTS idx_push_time ON push_log (sent_at DESC);

-- ── 采集健康（风控计数 / 上次成功时间 / 错误码）──
CREATE TABLE IF NOT EXISTS collect_health (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  vin            TEXT NOT NULL,
  kind           TEXT NOT NULL,         -- vss / travel / charge / scope
  ok             INTEGER DEFAULT 0,
  last_ok_at     TEXT,
  last_error     TEXT,
  error_count    INTEGER DEFAULT 0,
  updated_at     TEXT NOT NULL,
  UNIQUE (vin, kind)
);

-- ── 车辆位置（围栏判定用）──
CREATE TABLE IF NOT EXISTS position_sample (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  vin         TEXT NOT NULL,
  sampled_at  TEXT NOT NULL,
  lat         REAL,
  lon         REAL,
  altitude    REAL,
  direction   REAL,
  UNIQUE (vin, sampled_at)
);
CREATE INDEX IF NOT EXISTS idx_pos_time ON position_sample (vin, sampled_at DESC);

-- ── 地理围栏（家 / 公司；理想不提供，需自建）──
CREATE TABLE IF NOT EXISTS geofence (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  vin         TEXT NOT NULL,
  label       TEXT NOT NULL,            -- 家 / 公司
  lat         REAL NOT NULL,
  lon         REAL NOT NULL,
  radius_m    REAL NOT NULL DEFAULT 400,
  dwell_sec   INTEGER NOT NULL DEFAULT 300,
  enabled     INTEGER DEFAULT 1,
  created_at  TEXT NOT NULL
);

-- ── 运行时状态（行程会话、事件水位等 KV）──
CREATE TABLE IF NOT EXISTS runtime_state (
  k         TEXT PRIMARY KEY,
  v         TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ── 飞书事件回调日志（排查事件订阅是否生效）──
CREATE TABLE IF NOT EXISTS feishu_webhook_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  type       TEXT,
  event_type TEXT,
  has_encrypt INTEGER DEFAULT 0,
  preview    TEXT,
  processed  TEXT
);
CREATE INDEX IF NOT EXISTS idx_fwlog_time ON feishu_webhook_log (received_at DESC);
