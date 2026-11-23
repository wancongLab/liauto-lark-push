/**
 * 推送调度（Asia/Shanghai）
 *
 * 节奏（与 tesla-butler 同构，但按理想的数据特性调整）：
 *   · 每天 07:30  → 昨日用车小结（昨天的数据 00:10 已采集完整）
 *   · 每周一 08:00 → 上周汇总
 *   · 每月 1 日 08:30 → 上月汇总
 *
 *  所有推送都带幂等键（写 push_log），重复触发不会重发。
 */

import { shanghaiParts, shanghaiDate } from "./util.js";

/** 分钟数自 00:00 起 */
export function minutesOfDay(date = new Date()) {
  const p = shanghaiParts(date);
  return p.hour * 60 + p.minute;
}

/** ISO 周标识，如 2026-W44 */
export function isoWeekKey(date = new Date()) {
  const p = shanghaiParts(date);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const dayNum = (d.getUTCDay() + 6) % 7;        // 周一=0
  d.setUTCDate(d.getUTCDate() - dayNum + 3);       // 该周周四
  const isoYear = d.getUTCFullYear();
  const firstThu = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((d - firstThu) / (7 * 24 * 3600 * 1000));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** 上一个完整周的起止（周一 ~ 周日），按传入日期往前推一周 */
export function lastWeekRange(date = new Date()) {
  const p = shanghaiParts(date);
  const today = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const dayNum = (today.getUTCDay() + 6) % 7;      // 周一=0
  const monday = new Date(today);
  monday.setUTCDate(monday.getUTCDate() - dayNum - 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  const fmt = (x) => {
    const z = (n) => String(n).padStart(2, "0");
    return `${x.getUTCFullYear()}-${z(x.getUTCMonth() + 1)}-${z(x.getUTCDate())}`;
  };
  return { from: fmt(monday), to: fmt(sunday) };
}

/** 上一个完整月的起止 */
export function lastMonthRange(date = new Date()) {
  const p = shanghaiParts(date);
  const first = new Date(Date.UTC(p.year, p.month - 1, 1));
  first.setUTCMonth(first.getUTCMonth() - 1);
  const last = new Date(Date.UTC(p.year, p.month - 1, 1));
  last.setUTCDate(0);
  const fmt = (x) => {
    const z = (n) => String(n).padStart(2, "0");
    return `${x.getUTCFullYear()}-${z(x.getUTCMonth() + 1)}-${z(x.getUTCDate())}`;
  };
  return { from: fmt(first), to: fmt(last), month: `${first.getUTCFullYear()}-${String(first.getUTCMonth() + 1).padStart(2, "0")}` };
}

/**
 * 判断当前时刻应该触发哪些任务。
 * @returns {{daily:boolean, weekly:boolean, monthly:boolean, collect:boolean}}
 */
export function dueTasks(date = new Date()) {
  const p = shanghaiParts(date);
  const mins = minutesOfDay(date);
  const weekday = (p.weekday + 6) % 7;   // 周一=0 ... 周日=6
  const out = { daily: false, weekly: false, monthly: false, collect: false };
  // 采集昨天的数据：00:10 之后
  if (mins >= 10 && mins < 60 * 2) out.collect = true;
  // 每日小结：07:30
  if (mins >= 7 * 60 + 30 && mins < 7 * 60 + 40) out.daily = true;
  // 周报：周一 08:00
  if (weekday === 0 && mins >= 8 * 60 && mins < 8 * 60 + 10) out.weekly = true;
  // 月报：每月 1 日 08:30
  if (p.day === 1 && mins >= 8 * 60 + 30 && mins < 8 * 60 + 40) out.monthly = true;
  return out;
}

/** 幂等键 */
export const eventKeys = {
  daily: (vin, date) => `daily:${vin}:${date}`,
  weekly: (vin, weekKey) => `weekly:${vin}:${weekKey}`,
  monthly: (vin, month) => `monthly:${vin}:${month}`,
  collect: (vin, date) => `collect:${vin}:${date}`,
};

/**
 * 上海时间分量 → 定时任务的下一次触发时刻（D-071）
 *  不能用 `new Date("2026-11-03 07:30")`——Workers 本地时区是 UTC（D-064 踩坑 17）。
 *    这里只用「日期分量 + Date.UTC 求星期」做纯算术，不经过本地时区解析。
 */
export function nextRuns(nowText) {
  const m = String(nowText).match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const minute = Number(m[4]) * 60 + Number(m[5]);
  const weekday = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();   // 0=周日
  const pad = (n) => String(n).padStart(2, "0");
  const fmt = (yy, mm, dd, tm) => `${yy}-${pad(mm)}-${pad(dd)} ${tm}`;
  const addDays = (n) => {
    const t = new Date(Date.UTC(y, mo - 1, d + n));
    return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
  };

  // 每日 07:30
  let daily;
  if (minute < 7 * 60 + 30) daily = fmt(y, mo, d, "07:30");
  else { const [yy, mm, dd] = addDays(1); daily = fmt(yy, mm, dd, "07:30"); }

  // 每周一 08:00
  const toMon = (1 - weekday + 7) % 7;
  const monDelta = (toMon === 0 && minute >= 8 * 60) ? 7 : toMon;
  const [wy, wm, wd] = addDays(monDelta);
  const weekly = fmt(wy, wm, wd, "08:00");

  // 每月 1 日 08:30
  let monthly;
  if (d === 1 && minute < 8 * 60 + 30) monthly = fmt(y, mo, 1, "08:30");
  else {
    const ny = mo === 12 ? y + 1 : y;
    const nm = mo === 12 ? 1 : mo + 1;
    monthly = fmt(ny, nm, 1, "08:30");
  }

  return { daily, weekly, monthly };
}

/** 'YYYY-MM' → 该月首末日（UTC 日期字符串），月报对比用 */
export function monthRangeOf(month) {
  const [y, m] = String(month).split("-").map(Number);
  const fmt = (x) => `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}-${String(x.getUTCDate()).padStart(2, "0")}`;
  return { from: fmt(new Date(Date.UTC(y, m - 1, 1))), to: fmt(new Date(Date.UTC(y, m, 0))), month };
}

/** 'YYYY-MM' → 上一个月（跨年安全） */
export function monthBefore(month) {
  const [y, m] = String(month).split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
