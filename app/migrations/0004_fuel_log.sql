-- D-093：加油事件留档（月报要统计「加了几次油、多少升、多少钱」）
CREATE TABLE IF NOT EXISTS fuel_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vin TEXT NOT NULL,
  at TEXT NOT NULL,
  liters REAL,
  price_cny REAL,
  cost_cny REAL,
  source TEXT DEFAULT 'detect',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fuel_log_uid ON fuel_log(vin, at);
CREATE INDEX IF NOT EXISTS idx_fuel_log_at ON fuel_log(vin, at);
