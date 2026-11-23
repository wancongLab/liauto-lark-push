/** 时间与格式化工具（统一 Asia/Shanghai） */

const TZ_OFFSET_MIN = 8 * 60;

export function shanghaiParts(date = new Date()) {
  const t = new Date(date.getTime() + TZ_OFFSET_MIN * 60_000);
  return {
    year: t.getUTCFullYear(),
    month: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
    hour: t.getUTCHours(),
    minute: t.getUTCMinutes(),
    second: t.getUTCSeconds(),
    weekday: t.getUTCDay(),
  };
}

/** YYYY-MM-DD HH:MM:SS（Asia/Shanghai） */
export function shanghaiNow(date = new Date()) {
  const p = shanghaiParts(date);
  const z = (n) => String(n).padStart(2, "0");
  return `${p.year}-${z(p.month)}-${z(p.day)} ${z(p.hour)}:${z(p.minute)}:${z(p.second)}`;
}

/** YYYY-MM-DD（Asia/Shanghai） */
export function shanghaiDate(date = new Date()) {
  const p = shanghaiParts(date);
  const z = (n) => String(n).padStart(2, "0");
  return `${p.year}-${z(p.month)}-${z(p.day)}`;
}

/** YYYY-MM（Asia/Shanghai），充电接口用的 dt 格式 */
export function shanghaiMonth(date = new Date()) {
  const p = shanghaiParts(date);
  return `${p.year}-${p.month}`;
}

/** YYYY-MM-DD HH:MM:SS → Date（按 Asia/Shanghai 解析） */
export function parseShanghai(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - TZ_OFFSET_MIN * 60_000);
}

/** 毫秒时间戳 → YYYY-MM-DD HH:MM:SS */
export function fromMillis(ms) {
  if (!ms) return null;
  return shanghaiNow(new Date(Number(ms)));
}

/**
 *  D-064：两个「YYYY-MM-DD HH:MM:SS」（上海时区）时刻相差毫秒数。
 *
 *  背景（2026-11-02 实测根因）：`fromMillis(ms)` 返回的是
 *   "YYYY-MM-DD HH:MM:SS"（**不带时区标识**），而 JS 对这种字符串
 *   **按本地时区**解析 —— 本地开发机是 Asia/Shanghai 恰好正确，
 *   但 Cloudflare Workers 运行时的本地时区是 **UTC**
 *   （wrangler.toml 的 vars.TZ="Asia/Shanghai" 不影响 JS 运行时的 local timezone），
 *   于是偏差正好 8 小时 → 任何「时间窗口」匹配都会静默失效。
 *
 *  所以**永远不要**写 `new Date(fromMillis(ms))` 做时刻比较，
 *   一律用本函数（内部走 parseShanghai，无时区歧义）。
 */
export function shanghaiDiffMs(a, b) {
  const da = parseShanghai(a);
  const db = parseShanghai(b);
  if (!da || !db) return null;
  return Math.abs(da.getTime() - db.getTime());
}

export function round(n, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return null;
  const f = 10 ** digits;
  return Math.round(Number(n) * f) / f;
}

export function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 两个坐标的球面距离（米）—— 地理围栏判定用，无需高德 */
export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** 安全 JSON 解析 */
export function safeJson(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}
