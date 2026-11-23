/**
 * 主动提醒（D-088 第 1 批）：保养到期 / OTA 升级完成 / 停车掉电 / 充电故障
 *
 * 设计约束：
 *   - 只读：全部基于已采集的 VSS 快照与本地历史，不发任何车控命令。
 *   - 幂等：每条提醒都有去重键，宁可少提醒也不要刷屏。
 *   - 与推送开关解耦：本模块只**产出**卡片，发不发由 collector 用 pushTarget 决定，
 *     这样「关闭 保养」这类指令才能生效，而本模块不必知道飞书的存在。
 *
 * 数据可得性（2026-11-04 实测，见 D-088）：
 *    Maintain.* 六项（value 是 JSON 字符串，必须 parse）
 *    Version.OTA.Baseline（升级后才变；**没有**「有新版本可用」这类字段）
 *    Battery.ChargeFaults / EVESFltStopChrg
 *    12V 小电瓶：151 条里没有，另试 5 个候选 path 全 null → 这个功能做不了
 */

import * as db from "./db.js";
import * as cards from "./cards.js";
import { shanghaiDate, shanghaiDiffMs, shanghaiNow, round, num } from "./util.js";

// ── 保养 ────────────────────────────────────────────────────────────────
const MAINT_ITEMS = [
  ["enginelevel1", "增程器机油"],
  ["enginelevel2", "增程器机滤"],
  ["acfilter", "空调滤芯"],
  ["sparkplug", "火花塞"],
  ["coolfuild", "冷却液"],
  ["gearbrakeoil", "齿轮/刹车油"],
];
const MAINT_WARN_KM = 1500; // 剩 1500 km 提醒（按每周约 400 km 算，提前 ~3 周）
const MAINT_CRIT_KM = 500;
const MAINT_REPEAT_DAYS = 30; // 同一档位 30 天内不重复提醒

// ── OTA ────────────────────────────────────────────────────────────────
const OTA_PATH = "Vehicle.Version.OTA.Baseline";

// ── 停车掉电 ─────────────────────────────────────────────────────────────
const DRAIN_MIN_HOURS = 3; // 停车满 3 小时才评估
const DRAIN_MIN_PCT = 2; // 掉电 ≥2% 才提醒（1% 是采样噪声）

// ── 充电故障 ─────────────────────────────────────────────────────────────
const FAULT_PATHS = [
  ["Vehicle.Powertrain.Battery.ChargeFaults", "充电故障码"],
  ["Vehicle.Powertrain.Battery.EVESFltStopChrg", "充电中止标志"],
];

/** 取 VSS 值。 理想有些 path 的 value 是 JSON 字符串，必须再 parse 一次（D-086 踩过 3 次） */
function jval(payload, path) {
  let v = payload?.[path];
  if (v && typeof v === "object" && "value" in v) v = v.value;
  if (typeof v === "string") {
    const t = v.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try { v = JSON.parse(t); } catch { /* 保持原样 */ }
    }
  }
  return v ?? null;
}

function daysBetween(a, b) {
  const am = shanghaiDiffMs(a, b);
  if (am === null || am === undefined) return null;
  return am / 86400000;
}

/** 保养：剩余里程低于阈值时提醒；同一项同一档位 30 天内只提一次 */
export async function checkMaintenance(D1, vin, payload, now = shanghaiNow()) {
  const state = (await db.getState(D1, "rem:maint")) || {};
  const hits = [];
  const next = { ...state };
  for (const [key, label] of MAINT_ITEMS) {
    const v = jval(payload, `Vehicle.Carcenter.Maintain.${key}`);
    if (!v || typeof v !== "object") continue;
    const left = num(v.maintainLeftMileage, null);
    if (left === null) continue;
    const level = left <= MAINT_CRIT_KM ? "crit" : left <= MAINT_WARN_KM ? "warn" : null;
    const prev = state[key];
    if (!level) {
      if (prev) delete next[key]; // 换过件/里程重置 → 清状态，下次还能再提醒
      continue;
    }
    const sameLevelRecent =
      prev && prev.level === level && daysBetween(prev.at, now) !== null && daysBetween(prev.at, now) < MAINT_REPEAT_DAYS;
    const escalated = prev && prev.level !== level && (level === "crit" || prev.level !== "crit");
    if (sameLevelRecent && !escalated) continue;
    hits.push({
      key,
      label,
      left: Math.round(left),
      period: num(v.periodMileage, null),
      byEngine: String(v.mileageSource || "") === "engine",
      level,
    });
    next[key] = { level, at: now, left: Math.round(left) };
  }
  await db.setState(D1, "rem:maint", next);
  if (!hits.length) return null;
  hits.sort((a, b) => a.left - b.left);
  const crit = hits.some((h) => h.level === "crit");
  //  全部六项（含未到期的）都带上，卡片折叠里给完整保养台账；hits 只决定标题与配色（D-165）
  const all = [];
  for (const [key, label] of MAINT_ITEMS) {
    const v = jval(payload, `Vehicle.Carcenter.Maintain.${key}`);
    if (!v || typeof v !== "object") continue;
    const left = num(v.maintainLeftMileage, null);
    if (left === null) continue;
    const byEngine = String(v.mileageSource || "") === "engine";
    const dueRaw = String(v.maintainDueDate || "");     //  D-169：到期日 "20261129"
    const lastMs = num(v.maintenanceTime, null);        //  上次保养时间（ms）
    all.push({
      key,
      label,
      left: Math.round(left),
      period: num(v.periodMileage, null),
      byEngine,
      name: v.name || null,
      due: /^\d{8}$/.test(dueRaw) ? dueRaw : null,
      lastAt: lastMs ? new Date(lastMs + 8 * 3600 * 1000).toISOString().slice(0, 10) : null,
      lastKm: num(byEngine ? v.maintenanceEngineMileage : v.maintenanceMileage, null),
    });
  }
  return cards.buildMaintReminderCard({ items: all, hits, at: now, vehicle: await db.getVehicle(D1) });
}

/** OTA：只检测「已升级」（车机没有「有新版本可用」字段）；首次只记录不推 */
export async function checkOta(D1, vin, payload, now = shanghaiNow()) {
  const cur = jval(payload, OTA_PATH);
  if (!cur || typeof cur !== "string") return null;
  const state = await db.getState(D1, "rem:ota");
  if (!state || !state.baseline) {
    await db.setState(D1, "rem:ota", { baseline: cur, at: now });
    return null; // 首次只登记
  }
  if (state.baseline === cur) return null;
  await db.setState(D1, "rem:ota", { baseline: cur, at: now, prev: state.baseline });
  //  D-171：与其它卡统一四段式；完整版本号进折叠（主版本进三块，避免折行）
  return cards.buildOtaCard({
    before: state.baseline, after: cur, at: now,
    vehicle: await db.getVehicle(D1),
    icons: await db.getState(D1, "card:icons", null),
  });
}

/** 停车掉电：静止且未充电时按「停车段」累计，掉电 ≥2% 且满 3 小时才提醒 */
export async function checkParkingDrain(D1, vin, sample, now = shanghaiNow()) {
  const battery = num(sample?.battery, null);
  const moving = num(sample?.speed, 0) > 0;
  const charging = Boolean(sample?.charging);
  const parked = !moving && !charging && battery !== null;

  const state = await db.getState(D1, "rem:park");
  if (!parked) {
    if (state) await db.setState(D1, "rem:park", null);
    return null;
  }
  if (!state || typeof state.battery !== "number") {
    await db.setState(D1, "rem:park", { since: now, battery });
    return null;
  }
  const hours = (shanghaiDiffMs(state.since, now) ?? 0) / 3600000;
  const drop = state.battery - battery;
  if (hours < DRAIN_MIN_HOURS || drop < DRAIN_MIN_PCT) return null;

  const perHour = hours > 0 ? drop / hours : 0;
  await db.setState(D1, "rem:park", { since: now, battery }); // 重置基线，避免反复提醒
  //  D-170：改用与其它卡一致的四段式（三块 + 一句建议 + 折叠），不再走通用通知卡
  const detail = (await db.getState(D1, "last:detail", null)) || {};
  return cards.buildDrainCard({
    from: state.battery, to: battery, hours, perHour,
    since: state.since, at: now,
    sentinelText: detail.sentinel_text || null,
    vehicle: await db.getVehicle(D1),
    icons: await db.getState(D1, "card:icons", null),
  });
}

/** 充电故障：故障码非 0 或充电被中止时提醒（当天同一码只提一次） */
export async function checkChargeFault(D1, vin, payload, now = shanghaiNow()) {
  const day = shanghaiDate(new Date());
  const hits = [];
  for (const [path, label] of FAULT_PATHS) {
    const v = jval(payload, path);
    if (v === null || v === undefined) continue;
    const n = typeof v === "string" ? Number(v.trim()) : num(v, 0);
    if (!Number.isFinite(n) || n === 0) continue;
    hits.push({ path, label, code: n });
  }
  if (!hits.length) return null;
  const key = `rem:fault:${day}`;
  const seen = await db.getState(D1, key);
  const fresh = hits.filter((h) => !seen || !seen[String(h.code)]);
  if (!fresh.length) return null;
  const map = { ...(seen && typeof seen === "object" ? seen : {}) };
  for (const h of fresh) map[String(h.code)] = now;
  await db.setState(D1, key, map);
  //  D-172：与其它卡统一四段式；码只摆值，不猜硬件原因
  //  D-172：码表未公开 → 不上码；用结束电量判断「自动完成 / 提前结束」
  const soc = num(jval(payload, "Vehicle.Powertrain.Battery.ResidueBattery"), null);
  return cards.buildChargeFaultCard({
    at: now, battery: soc,
    vehicle: await db.getVehicle(D1),
    icons: await db.getState(D1, "card:icons", null),
  });
}

/**
 * 统一入口：跑全部提醒，返回 [{kind, card, dedupeKey}]。
 * collector 负责按推送开关过滤 + 落 push_log 幂等。
 */
export async function runReminders(D1, vin, sample, payload, now = shanghaiNow()) {
  const out = [];
  const day = shanghaiDate(new Date());
  const tasks = [
    ["maint", () => checkMaintenance(D1, vin, payload, now)],
    ["ota", () => checkOta(D1, vin, payload, now)],
    ["drain", () => checkParkingDrain(D1, vin, sample, now)],
    ["fault", () => checkChargeFault(D1, vin, payload, now)],
  ];
  for (const [kind, fn] of tasks) {
    try {
      const card = await fn();
      if (card) out.push({ kind, card, dedupeKey: `rem:${kind}:${vin}:${day}` });
    } catch (err) {
      console.error(`[reminders] ${kind} 失败:`, err?.message);
    }
  }
  return out;
}

export const __test = { jval, checkMaintenance, checkOta, checkParkingDrain, checkChargeFault, MAINT_ITEMS };

/** 示例卡（运维/预览用）：`POST /api/push {"kind":"sample","what":"maint"}` 可发一张样子给用户看 */
export function sampleReminderCard(what = "maint") {
  const now = shanghaiNow();
  if (what === "ota") {
    return cards.buildNoticeCard({
      title: "车辆已升级", subtitle: "OTA 版本已变化（示例）", template: "green",
      rows: [
        { label: "升级前", value: "8.6.0-1.55.253" },
        { label: "升级后", value: "**8.7.0-1.60.1**" },
        { label: "时间", value: now },
      ],
      footNote: "这是示例卡，真实推送只在车机版本变化时发。",
    });
  }
  if (what === "drain") {
    return cards.buildNoticeCard({
      title: "停车掉电", subtitle: "未充电状态下电量下降（示例）", template: "orange",
      rows: [
        { label: "停车时段", value: `2026-11-05 20:10:00 → 2026-11-06 07:30:00` },
        { label: "电量", value: `48% → 44%（−4%）` },
        { label: "折合", value: "约 0.35 %/小时" },
        { label: "可能原因", value: "哨兵/驻车保电/低温自加热，长期停建议插枪" },
      ],
      footNote: "这是示例卡，真实推送只在停车 ≥3 小时且掉电 ≥2% 时发。",
    });
  }
  if (what === "fault") {
    return cards.buildNoticeCard({
      title: "充电异常", subtitle: "车机上报充电故障（示例）", template: "red",
      rows: [{ label: "充电故障码", value: "**3**" }],
      footNote: "这是示例卡，真实推送只在故障码非 0 或充电被中止时发。",
    });
  }
  return cards.buildNoticeCard({
    title: "保养提醒", subtitle: "还有一段时间，可提前预约（示例）", template: "orange",
    rows: [
      { label: "增程器机油", value: "剩 **7374 km**（周期 10000 km · 按增程器里程计）" },
      { label: "空调滤芯", value: "剩 **9459 km**（周期 20000 km · 按总里程计）" },
    ],
    footNote: "这是示例卡，真实推送在剩余 ≤1500 km 时发（≤500 km 转红）。",
  });
}
