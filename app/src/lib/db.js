/** D1 数据访问层 */

import { shanghaiNow, shanghaiDiffMs } from "./util.js";

export async function ensureVehicle(db, vehicle) {
  const now = shanghaiNow();
  await db.prepare(`
    INSERT INTO vehicle (vin, spu, series_no, model_no, nickname, plate_no,
                         seat_count, vehicle_type, role_id, energy_type, raw_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(vin) DO UPDATE SET
      spu=excluded.spu, series_no=excluded.series_no, model_no=excluded.model_no,
      nickname=excluded.nickname, plate_no=excluded.plate_no,
      seat_count=excluded.seat_count, vehicle_type=excluded.vehicle_type,
      role_id=excluded.role_id, energy_type=excluded.energy_type,
      raw_json=excluded.raw_json, updated_at=excluded.updated_at
  `).bind(
    vehicle.vin, vehicle.spu || null, vehicle.series_no || null, vehicle.model_no || null,
    vehicle.nickname || null, vehicle.plate_no || null, vehicle.seat_count || null,
    vehicle.vehicle_type || null, vehicle.role_id || null, vehicle.energy_type || null,
    JSON.stringify(vehicle.raw || {}), now,
  ).run();
}

export async function getVehicle(db) {
  const row = await db.prepare(
    "SELECT * FROM vehicle ORDER BY updated_at DESC LIMIT 1",
  ).first();
  if (!row) return null;
  return { ...row, raw: JSON.parse(row.raw_json || "{}") };
}

export async function saveSample(db, s) {
  await db.prepare(`
    INSERT INTO signal_sample
      (vin, sampled_at, battery, range_km, odometer_km, speed, indoor_temp, outdoor_temp,
       charging, charge_status, travel_status, trip_total_json, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(vin, sampled_at) DO UPDATE SET
      battery=excluded.battery, range_km=excluded.range_km, odometer_km=excluded.odometer_km,
      speed=excluded.speed, indoor_temp=excluded.indoor_temp, outdoor_temp=excluded.outdoor_temp,
      charging=excluded.charging, charge_status=excluded.charge_status,
      travel_status=excluded.travel_status, trip_total_json=excluded.trip_total_json,
      payload=excluded.payload
  `).bind(
    s.vin, s.sampled_at, s.battery, s.range_km, s.odometer_km, s.speed,
    s.indoor_temp, s.outdoor_temp, s.charging, s.charge_status, s.travel_status,
    s.trip_total_json, JSON.stringify(s.payload || {}),
  ).run();
}

export async function lastSample(db, vin) {
  return db.prepare(
    "SELECT * FROM signal_sample WHERE vin=? ORDER BY sampled_at DESC LIMIT 1",
  ).bind(vin).first();
}

export async function recentSamples(db, vin, limit = 120) {
  const { results } = await db.prepare(
    "SELECT * FROM signal_sample WHERE vin=? ORDER BY sampled_at DESC LIMIT ?",
  ).bind(vin, limit).all();
  return results || [];
}

export async function upsertDaily(db, d) {
  await db.prepare(`
    INSERT INTO daily_stat
      (vin, stat_date, travel_km, elec_km, hybrid_km, elec_kwh, fuel_l,
       avg_elec_kwh_per_100km, avg_fuel_l_per_100km, ad_km, noa_km,
       charge_kwh, charge_times, cost_cny, fuel_cost_cny, source, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(vin, stat_date) DO UPDATE SET
      travel_km=excluded.travel_km, elec_km=excluded.elec_km, hybrid_km=excluded.hybrid_km,
      elec_kwh=excluded.elec_kwh, fuel_l=excluded.fuel_l,
      avg_elec_kwh_per_100km=excluded.avg_elec_kwh_per_100km,
      avg_fuel_l_per_100km=excluded.avg_fuel_l_per_100km,
      ad_km=excluded.ad_km, noa_km=excluded.noa_km,
      charge_kwh=excluded.charge_kwh, charge_times=excluded.charge_times,
      cost_cny=excluded.cost_cny, fuel_cost_cny=excluded.fuel_cost_cny,
      source=excluded.source, updated_at=excluded.updated_at
  `).bind(
    d.vin, d.stat_date, d.travel_km || 0, d.elec_km || 0, d.hybrid_km || 0,
    d.elec_kwh || 0, d.fuel_l || 0, d.avg_elec_kwh_per_100km, d.avg_fuel_l_per_100km,
    d.ad_km || 0, d.noa_km || 0, d.charge_kwh || 0, d.charge_times || 0,
    d.cost_cny || 0, d.fuel_cost_cny || 0, d.source || "travel", shanghaiNow(),
  ).run();
}

export async function getDaily(db, vin, date) {
  return db.prepare(
    "SELECT * FROM daily_stat WHERE vin=? AND stat_date=?",
  ).bind(vin, date).first();
}

export async function listDaily(db, vin, fromDate, toDate) {
  const { results } = await db.prepare(
    "SELECT * FROM daily_stat WHERE vin=? AND stat_date>=? AND stat_date<=? ORDER BY stat_date",
  ).bind(vin, fromDate, toDate).all();
  return results || [];
}

/** 幂等：成功返回 true（已推送过）；失败返回 false */
export async function markPushed(db, vin, eventKey, channel, payload) {
  const res = await db.prepare(`
    INSERT OR IGNORE INTO push_log (vin, event_key, channel, payload, sent_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(vin, eventKey, channel, JSON.stringify(payload || {}), shanghaiNow()).run();
  return (res.meta?.changes || 0) > 0;
}

/** 最近的推送记录（push_log 倒序）—— 推送时间表页要用 */
export async function listPushed(db, vin, limit = 12) {
  const { results } = await db
    .prepare("SELECT event_key, channel, sent_at FROM push_log WHERE vin = ? ORDER BY sent_at DESC LIMIT ?")
    .bind(vin, limit).all();
  return results || [];
}

/** 某天以来的推送条数（用于展示「今天推了几条」） */
export async function countPushedSince(db, vin, sinceDate) {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM push_log WHERE vin = ? AND sent_at >= ?")
    .bind(vin, sinceDate).first();
  return Number(row?.n || 0);
}

export async function healthUpsert(db, vin, kind, ok, error) {
  const now = shanghaiNow();
  await db.prepare(`
    INSERT INTO collect_health (vin, kind, ok, last_ok_at, last_error, error_count, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(vin, kind) DO UPDATE SET
      ok=excluded.ok,
      last_ok_at=CASE WHEN excluded.ok=1 THEN excluded.last_ok_at ELSE collect_health.last_ok_at END,
      last_error=excluded.last_error,
      error_count=CASE WHEN excluded.ok=1 THEN 0 ELSE collect_health.error_count+1 END,
      updated_at=excluded.updated_at
  `).bind(vin, kind, ok ? 1 : 0, ok ? now : null, error ? String(error).slice(0, 300) : null, 0, now).run();
}

export async function listHealth(db, vin) {
  const { results } = await db.prepare(
    "SELECT * FROM collect_health WHERE vin=? ORDER BY kind",
  ).bind(vin).all();
  return results || [];
}

/** 默认电价（取当前生效的） */
export async function currentPrice(db) {
  const row = await db.prepare(`
    SELECT price_cny FROM price_rule
    WHERE scope='default' AND effective_from<=?
      AND (effective_to IS NULL OR effective_to>?)
    ORDER BY effective_from DESC LIMIT 1
  `).bind(shanghaiNow(), shanghaiNow()).first();
  return row ? row.price_cny : null;
}

export async function setDefaultPrice(db, priceCny) {
  const now = shanghaiNow();
  await db.prepare(
    "UPDATE price_rule SET effective_to=? WHERE scope='default' AND effective_to IS NULL",
  ).bind(now).run();
  await db.prepare(`
    INSERT INTO price_rule (scope, price_cny, effective_from, source, created_at)
    VALUES ('default', ?, ?, 'manual', ?)
  `).bind(priceCny, now, now).run();
}

// ──  D-068：分时段电价（峰谷）────────────────────────────────
// 用户 2026-11-03 从「理想 APP → 充电 → 电价详情」截图给出 7 个时段
// （单价 = 电费 + 服务费，即到手价）：
//   00:00~01:00 0.90 / 01:00~05:00 0.68 / 05:00~11:30 0.90 /
//   11:30~14:30 0.68 / 14:30~16:00 0.90 / 16:00~22:00 1.15 / 22:00~24:00 0.90
//
// 存储：复用 price_rule（scope='elec_tier'，note 存 {"from","to","label"}），
// 不新建表 —— 新建表要 `wrangler d1 migrations apply --remote`，
// 而这条链路只需要「当前生效的一组时段价」，复用现有表零迁移成本。
const MIN_PER_DAY = 24 * 60;

function hhmmToMin(x) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(x || "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 上海时间字符串 "YYYY-MM-DD HH:MM…" → 当日分钟数。
 *   直接切字符，不经过 Date —— Workers 本地时区是 UTC（见 D-064）。 */
function tsToMin(ts) {
  const m = /^\d{4}-\d{2}-\d{2} (\d{2}):(\d{2})/.exec(String(ts || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export async function listElecTiers(db) {
  const { results } = await db.prepare(
    "SELECT price_cny, note FROM price_rule WHERE scope='elec_tier' AND (effective_to IS NULL OR effective_to>?) ORDER BY id",
  ).bind(shanghaiNow()).all();
  return (results || []).map((r) => {
    let w = {};
    try { w = JSON.parse(r.note || "{}") || {}; } catch { w = {}; }
    return { price: Number(r.price_cny), from: w.from || null, to: w.to || null, label: w.label || null };
  });
}

export async function setElecTiers(db, tiers) {
  const now = shanghaiNow();
  await db.prepare(
    "UPDATE price_rule SET effective_to=? WHERE scope='elec_tier' AND effective_to IS NULL",
  ).bind(now).run();
  for (const t of tiers || []) {
    const from = hhmmToMin(t.from);
    const to = hhmmToMin(t.to);
    if (from === null || to === null || !Number.isFinite(Number(t.price))) continue;
    await db.prepare(`
      INSERT INTO price_rule (scope, price_cny, effective_from, source, note, created_at)
      VALUES ('elec_tier', ?, ?, 'user', ?, ?)
    `).bind(
      Number(t.price), now,
      JSON.stringify({ from: t.from, to: t.to, label: t.label || null }), now,
    ).run();
  }
}

/** 同步版：某一分钟（0..1439）属于哪个时段价；没有分档就回退 */
function pickTierPrice(tiers, min, fallback) {
  const m = ((min % MIN_PER_DAY) + MIN_PER_DAY) % MIN_PER_DAY;
  for (const t of tiers) {
    const f = hhmmToMin(t.from);
    const to = hhmmToMin(t.to);
    if (f === null || to === null) continue;
    const end = to === 0 ? MIN_PER_DAY : to;   // "24:00" 正常解析成 1440；"00:00" 视为一天结尾
    if (m >= f && m < end) return t.price;
  }
  return fallback;
}

/** 某时刻的电价（不分档时 = 默认电价） */
export async function elecTierPriceAt(db, ts) {
  const def = await currentPrice(db);
  const min = tsToMin(ts);
  if (min === null) return def;
  const tiers = await listElecTiers(db);
  if (!tiers.length) return def;
  return pickTierPrice(tiers, min, def);
}

/**
 * 一段时间的电价：{ start, avg, tiered }。
 * 充电可能跨时段（如 22:40 开始、次日 00:20 结束）→ 按【分钟数加权】平均单价。
 *  假设功率恒定 —— 理想不提供分段功率（D-062），所以这是「约」值。
 */
export async function elecPriceWindow(db, startedAt, endedAt) {
  const def = await currentPrice(db);
  const sMin = tsToMin(startedAt);
  let eMin = tsToMin(endedAt);
  if (sMin === null) return { start: def, avg: def, tiered: false };
  if (eMin === null) eMin = sMin + 1;
  else if (eMin === sMin) eMin = sMin + 1;                  // 同一分钟 → 单点
  else if (eMin < sMin) eMin += MIN_PER_DAY;                // 跨天（结束时刻的分钟数更小）
  if (eMin - sMin > 2 * MIN_PER_DAY) eMin = sMin + 1;       // 防御：异常时间戳
  const tiers = await listElecTiers(db);
  if (!tiers.length) return { start: def, avg: def, tiered: false };
  let sum = 0, n = 0, startPrice = null;
  for (let m = sMin; m < eMin; m++, n++) {
    const p = pickTierPrice(tiers, m, def);
    if (startPrice === null) startPrice = p;
    if (p !== null) sum += p;
  }
  const avg = n && sum ? Math.round((sum / n) * 1000) / 1000 : def;
  return { start: startPrice ?? def, avg, tiered: true };
}

export async function upsertGeofence(db, g) {
  await db.prepare("DELETE FROM geofence WHERE vin=? AND label=?").bind(g.vin, g.label).run();
  await db.prepare(`
    INSERT INTO geofence (vin, label, lat, lon, radius_m, dwell_sec, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
  `).bind(g.vin, g.label, g.lat, g.lon, g.radius_m ?? 400, g.dwell_sec ?? 300, shanghaiNow()).run();
}

// ── 加油事件（D-093）──
export async function saveFuelLog(db, r) {
  await db.prepare(`
    INSERT OR IGNORE INTO fuel_log (vin, at, liters, price_cny, cost_cny, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(r.vin, r.at, r.liters ?? null, r.price_cny ?? null, r.cost_cny ?? null, r.source || "detect", shanghaiNow()).run();
}

/**
 * 提交油价后回写那一条加油记录的单价与金额（D-182）。
 * 加油检测时先按「当时的有效油价」入库，用户填了真实单价后必须回写，
 * 否则月报/明细一直用旧价算钱。
 */
export async function updateFuelLogPrice(db, vin, at, priceCny, costCny) {
  await db.prepare(
    "UPDATE fuel_log SET price_cny=?, cost_cny=? WHERE vin=? AND at=?",
  ).bind(priceCny, costCny, vin, at).run();
}

export async function listFuelLogs(db, vin, from, to) {
  return (await db.prepare(
    "SELECT * FROM fuel_log WHERE vin=? AND at>=? AND at<=? ORDER BY at",
  ).bind(vin, from, to).all()).results || [];
}

export async function lastFuelLog(db, vin) {
  return db.prepare("SELECT * FROM fuel_log WHERE vin=? ORDER BY at DESC LIMIT 1").bind(vin).first();
}

export async function upsertChargeSession(db, s) {
  await db.prepare(`
    INSERT INTO charge_session
      (vin, session_key, started_at, ended_at, duration_min, capacity_kwh,
       charging_type, avg_power_kw, cost_cny, price_per_kwh, station_name, confirmed, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(vin, session_key) DO UPDATE SET
      ended_at=COALESCE(excluded.ended_at, charge_session.ended_at),
      duration_min=COALESCE(excluded.duration_min, charge_session.duration_min),
      --  D-064：capacity_kwh / charging_type 也要参与补写。
      --   理想侧 chargeRecords 常常在充电结束【之后】才写入那一行，
      --   结束瞬间拿不到电量 → 这两个字段原本是 NULL 且不会被更新，
      --   导致「补齐会话」的重试永远写不进去。
      capacity_kwh=COALESCE(excluded.capacity_kwh, charge_session.capacity_kwh),
      charging_type=COALESCE(excluded.charging_type, charge_session.charging_type),
      avg_power_kw=COALESCE(excluded.avg_power_kw, charge_session.avg_power_kw),
      cost_cny=COALESCE(excluded.cost_cny, charge_session.cost_cny),
      price_per_kwh=COALESCE(excluded.price_per_kwh, charge_session.price_per_kwh)
  `).bind(
    s.vin, s.session_key, s.started_at, s.ended_at || null, s.duration_min || null,
    s.capacity_kwh || null, s.charging_type || null, s.avg_power_kw || null,
    s.cost_cny || null, s.price_per_kwh || null, s.station_name || null,
    s.confirmed || 0, shanghaiNow(),
  ).run();
}

/**
 * 某一天开始的充电会话（D-069：日报电费口径改成「按实际充电时段结算」）。
 *   date 是上海时区 `YYYY-MM-DD`，直接比对 started_at 前 10 个字符 —— 不经过 Date，
 *   避免 D-064 那种 Workers 本地时区（UTC）带来的偏移。
 */
/**
 *  D-078：最近一次充电的【实际电价】。
 *
 * 用户口径（2026-11-04 明确指出）：电费应该按「充进去那一刻的电价」结算，
 * 然后一直沿用到下一次充电 —— 因为那段时间车上存的电就是那个价买来的。
 * 所以日报/行程卡的用车电费不能用「推送时刻的分时电价」。
 */
export async function lastChargePrice(db, vin, beforeTs = null) {
  const sql = `SELECT session_key, started_at, ended_at, price_per_kwh, capacity_kwh
               FROM charge_session
               WHERE vin=? AND price_per_kwh IS NOT NULL` +
    (beforeTs ? " AND started_at <= ?" : "") +
    " ORDER BY started_at DESC LIMIT 1";
  const stmt = beforeTs ? db.prepare(sql).bind(vin, beforeTs) : db.prepare(sql).bind(vin);
  return (await stmt.first()) || null;
}

/** 取某时刻附近最近的一条电量采样（反推 kWh/1% 用）。返回 number 或 null */
export async function batteryNear(db, vin, ts, windowMin = 25) {
  const m = String(ts || "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  //  日期分量是 Asia/Shanghai 壁钟：Date.UTC 当 UTC 组包后要减 8h 才是真实 epoch；
  //    再用 fmt() 加回 8h 得到壁钟字符串。**不要**用 strftime('%s',...) 跟真实 epoch 比
  //    —— 它把壁钟当 UTC，会整体差 8 小时（D-078 踩过，导致取到窗口里最早那条）。
  const base = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - 8 * 3600_000;
  const fmt = (ms) => {
    const d = new Date(ms + 8 * 3600_000);
    const z = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${z(d.getUTCMonth() + 1)}-${z(d.getUTCDate())} ` +
      `${z(d.getUTCHours())}:${z(d.getUTCMinutes())}:${z(d.getUTCSeconds())}`;
  };
  const lo = fmt(base - windowMin * 60_000);
  const hi = fmt(base + windowMin * 60_000);
  const { results } = await db.prepare(
    `SELECT sampled_at, battery FROM signal_sample
     WHERE vin=? AND sampled_at BETWEEN ? AND ? AND battery IS NOT NULL
     ORDER BY sampled_at`,
  ).bind(vin, lo, hi).all();
  if (!results || !results.length) return null;
  let best = null;
  let bestD = Infinity;
  for (const r of results) {
    const d = shanghaiDiffMs(r.sampled_at, ts);
    if (d !== null && d < bestD) { bestD = d; best = r; }
  }
  return best ? Number(best.battery) : null;
}

/** 删除一条充电会话（去重用：理想明细与实时状态机会给同一次充电建两行） */
export async function deleteChargeSession(db, vin, sessionKey) {
  await db.prepare("DELETE FROM charge_session WHERE vin=? AND session_key=?").bind(vin, sessionKey).run();
}

/** 是否已存在覆盖该开始时刻的充电会话（±windowMin 内），用于去重 */
export async function hasChargeSessionNear(db, vin, started, windowMin = 5) {
  const m = String(started || "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return false;
  const base = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - 8 * 3600_000;
  const fmt = (ms) => {
    const d = new Date(ms + 8 * 3600_000);
    const z = (n) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${z(d.getUTCMonth() + 1)}-${z(d.getUTCDate())} ` +
      `${z(d.getUTCHours())}:${z(d.getUTCMinutes())}:${z(d.getUTCSeconds())}`;
  };
  const row = await db.prepare(
    "SELECT id FROM charge_session WHERE vin=? AND started_at BETWEEN ? AND ? LIMIT 1",
  ).bind(vin, fmt(base - windowMin * 60_000), fmt(base + windowMin * 60_000)).first();
  return !!row;
}

export async function listChargeSessionsOnDate(db, vin, date) {
  if (!db) return [];
  const r = await db
    .prepare("SELECT * FROM charge_session WHERE vin=? AND substr(started_at,1,10)=? ORDER BY started_at")
    .bind(vin, date)
    .all();
  return r.results || [];
}

export async function listChargeSessions(db, vin, limit = 50) {
  const { results } = await db.prepare(
    "SELECT * FROM charge_session WHERE vin=? ORDER BY started_at DESC LIMIT ?",
  ).bind(vin, limit).all();
  return results || [];
}

export async function openChargeSession(db, vin) {
  return db.prepare(
    "SELECT * FROM charge_session WHERE vin=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
  ).bind(vin).first();
}

/** 油价（元/L），scope='fuel' */
export async function currentFuelPrice(db) {
  const row = await db.prepare(`
    SELECT price_cny FROM price_rule
    WHERE scope='fuel' AND effective_from<=?
      AND (effective_to IS NULL OR effective_to>?)
    ORDER BY effective_from DESC LIMIT 1
  `).bind(shanghaiNow(), shanghaiNow()).first();
  return row ? row.price_cny : null;
}

/** 当前油价行（含生效时间）：卡片要显示「上次更新 11-03」这类信息 */
export async function currentFuelPriceRow(db) {
  return await db.prepare(`
    SELECT price_cny, effective_from FROM price_rule
    WHERE scope='fuel' AND effective_from<=?
      AND (effective_to IS NULL OR effective_to>?)
    ORDER BY effective_from DESC LIMIT 1
  `).bind(shanghaiNow(), shanghaiNow()).first();
}

export async function setFuelPrice(db, priceCny) {
  const now = shanghaiNow();
  await db.prepare(
    "UPDATE price_rule SET effective_to=? WHERE scope='fuel' AND effective_to IS NULL",
  ).bind(now).run();
  await db.prepare(`
    INSERT INTO price_rule (scope, price_cny, effective_from, source, created_at)
    VALUES ('fuel', ?, ?, 'manual', ?)
  `).bind(priceCny, now, now).run();
}

/** 运行时 KV */
export async function getState(db, k, fallback = null) {
  const row = await db.prepare("SELECT v FROM runtime_state WHERE k=?").bind(k).first();
  if (!row) return fallback;
  try { return JSON.parse(row.v); } catch { return fallback; }
}

export async function setState(db, k, v) {
  await db.prepare(`
    INSERT INTO runtime_state (k, v, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at
  `).bind(k, JSON.stringify(v), shanghaiNow()).run();
}

export async function savePosition(db, p) {
  await db.prepare(`
    INSERT INTO position_sample (vin, sampled_at, lat, lon, altitude, direction)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(vin, sampled_at) DO UPDATE SET
      lat=excluded.lat, lon=excluded.lon, altitude=excluded.altitude, direction=excluded.direction
  `).bind(p.vin, p.sampled_at, p.lat, p.lon, p.altitude, p.direction).run();
}

/**
 * 取最近若干天的位置采样（D-073 用来自学围栏中心）。
 * 只取「车停着」的点（speed 缺列时退化为全取），因为围栏关心的是停车点，不是路过点。
 */
export async function listRecentPositions(db, vin, opts = {}) {
  const days = Number(opts.days ?? 14);
  const limit = Number(opts.limit ?? 2000);
  const since = opts.since || null;
  const sql = since
    ? "SELECT lat, lon, sampled_at FROM position_sample WHERE vin=? AND sampled_at>=? ORDER BY sampled_at DESC LIMIT ?"
    : "SELECT lat, lon, sampled_at FROM position_sample WHERE vin=? ORDER BY sampled_at DESC LIMIT ?";
  const stmt = db.prepare(sql);
  const { results } = since
    ? await stmt.bind(vin, since, limit).all()
    : await stmt.bind(vin, limit).all();
  return (results || []).filter((r) => r.lat !== null && r.lon !== null);
}

/** 只更新围栏中心/半径（保留 label/dwell/enabled），用于 D-073 的车学坐标纠偏 */
export async function updateGeofenceGeometry(db, vin, label, geom) {
  await db.prepare(
    "UPDATE geofence SET lat=?, lon=?, radius_m=? WHERE vin=? AND label=?",
  ).bind(Number(geom.lat), Number(geom.lon), Number(geom.radius_m), vin, label).run();
}

/** 行程窗口内的位置采样（D-076 画线路图用），按时间正序 */
export async function listPositionsBetween(db, vin, from, to) {
  const { results } = await db.prepare(
    "SELECT sampled_at, lat, lon FROM position_sample WHERE vin=? AND sampled_at>=? AND sampled_at<=? ORDER BY sampled_at ASC",
  ).bind(vin, from, to).all();
  return (results || []).filter((r) => r.lat !== null && r.lon !== null);
}

/** 时间段内的采样（按时间正序），用于回溯补行程（D-077） */
export async function listSamplesBetween(db, vin, from, to) {
  const { results } = await db.prepare(
    "SELECT sampled_at, odometer_km, battery, trip_total_json FROM signal_sample WHERE vin=? AND sampled_at>=? AND sampled_at<=? ORDER BY sampled_at ASC",
  ).bind(vin, from, to).all();
  return results || [];
}

/** 落一条行程（幂等：同 vin + started_at 只保留一条），返回行 id */
export async function saveTripLog(db, t) {
  await db.prepare(`
    INSERT INTO trip_log (
      vin, started_at, ended_at, distance_km, duration_min, elec_km, engine_km, ad_km,
      battery_from, battery_to, start_loc, end_loc, start_lat, start_lon, end_lat, end_lon, created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(vin, started_at) DO UPDATE SET
      --  D-089：重算时不要把「结束时刻/时长」改短（backfill 用的是最后一个移动点+1，
      --   实时路径记的是真正停滞判定的时刻，后者更准）。字符串格式可直接比较。
      ended_at=CASE WHEN trip_log.ended_at IS NULL OR excluded.ended_at > trip_log.ended_at
                    THEN excluded.ended_at ELSE trip_log.ended_at END,
      -- 用 COALESCE 保护「部分字段重算」：重建线路图时只传窗口和里程，
      -- 不该把已算好的纯电/发动机里程、电量清空（D-085 踩坑）
      distance_km=COALESCE(excluded.distance_km, trip_log.distance_km),
      duration_min=CASE WHEN trip_log.duration_min IS NULL OR excluded.duration_min > trip_log.duration_min
                        THEN excluded.duration_min ELSE trip_log.duration_min END,
      elec_km=COALESCE(excluded.elec_km, trip_log.elec_km),
      engine_km=COALESCE(excluded.engine_km, trip_log.engine_km),
      ad_km=COALESCE(excluded.ad_km, trip_log.ad_km),
      battery_from=COALESCE(excluded.battery_from, trip_log.battery_from),
      battery_to=COALESCE(excluded.battery_to, trip_log.battery_to),
      start_loc=excluded.start_loc, end_loc=excluded.end_loc,
      start_lat=excluded.start_lat, start_lon=excluded.start_lon,
      end_lat=excluded.end_lat, end_lon=excluded.end_lon
  `).bind(
    t.vin, t.started_at, t.ended_at ?? null, t.distance_km ?? null, t.duration_min ?? null,
    t.elec_km ?? null, t.engine_km ?? null, t.ad_km ?? null,
    t.battery_from ?? null, t.battery_to ?? null,
    t.start_loc ?? null, t.end_loc ?? null,
    t.start_lat ?? null, t.start_lon ?? null, t.end_lat ?? null, t.end_lon ?? null,
    t.created_at || t.started_at,
  ).run();
  const row = await db.prepare("SELECT id FROM trip_log WHERE vin=? AND started_at=?")
    .bind(t.vin, t.started_at).first();
  return row ? row.id : null;
}

export async function listTripLogs(db, vin, limit = 30) {
  const { results } = await db.prepare(
    "SELECT id, started_at, ended_at, distance_km, duration_min, elec_km, engine_km, ad_km, battery_from, battery_to, start_loc, end_loc, route_km, route_source FROM trip_log WHERE vin=? ORDER BY started_at DESC LIMIT ?",
  ).bind(vin, Number(limit)).all();
  return results || [];
}

/** 按开始时刻找行程（backfill 判断「实时路径是否已经写过这一条」用） */
export async function getTripLogByStart(db, vin, startedAt) {
  return db.prepare("SELECT * FROM trip_log WHERE vin=? AND started_at=?").bind(vin, startedAt).first();
}

export async function getTripLog(db, vin, id) {
  return db.prepare("SELECT * FROM trip_log WHERE vin=? AND id=?").bind(vin, Number(id)).first();
}

/** 回写线路（纠偏点列 GCJ-02 的 JSON 字符串） */
export async function updateTripRoute(db, id, r) {
  await db.prepare(
    "UPDATE trip_log SET route_points=?, route_km=?, route_source=?, route_error=?, " +
    "start_loc=COALESCE(?, start_loc), end_loc=COALESCE(?, end_loc) WHERE id=?",
  ).bind(
    r.route_points ?? null, r.route_km ?? null, r.route_source ?? null, r.route_error ?? null,
    r.start_loc ?? null, r.end_loc ?? null, Number(id),
  ).run();
}

export async function listGeofences(db, vin) {
  const { results } = await db.prepare(
    "SELECT * FROM geofence WHERE vin=? AND enabled=1",
  ).bind(vin).all();
  return results || [];
}
