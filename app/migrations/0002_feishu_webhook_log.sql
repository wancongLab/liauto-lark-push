-- 飞书事件回调命中日志（排查事件订阅是否生效）
CREATE TABLE IF NOT EXISTS feishu_webhook_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  type        TEXT,
  event_type  TEXT,
  has_encrypt INTEGER DEFAULT 0,
  preview     TEXT,
  processed   TEXT
);
CREATE INDEX IF NOT EXISTS idx_fwlog_time ON feishu_webhook_log (received_at DESC);
