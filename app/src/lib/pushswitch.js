// 推送开关（D-086）
// 为什么单独一个模块：collector.js 要读它决定「要不要推这张卡」，commands.js 要读写它，
// 如果放 commands.js 会形成 collector ↔ commands 的循环依赖。
import * as db from "./db.js";

const KEY = "push:switch";

// 可按类关闭的推送。日报/周报/月报不在此列（那是主干，关掉等于停服）。
export const SWITCH_KINDS = ["geo", "trip", "fuel", "anomaly", "energy", "charge", "maint", "ota", "drain", "fault", "advice", "park"];
export const SWITCH_LABELS = {
  geo: "到家/离开",
  trip: "行程小结",
  fuel: "加油提醒",
  anomaly: "异常提醒",
  energy: "能量提醒（低电/低油）",
  charge: "充电提醒",
  maint: "保养提醒",
  ota: "OTA 升级",
  drain: "停车掉电",
  fault: "充电故障",
  advice: "建议及时充电（谷时提醒）",
  park: "泊车照片",
};

/** 读取全部开关（缺省=开） */
export async function getSwitches(D1) {
  const raw = await db.getState(D1, KEY);
  const o = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const k of SWITCH_KINDS) out[k] = o[k] !== false;
  return out;
}

/** 设置单个开关，返回最新全量 */
export async function setSwitch(D1, kind, on) {
  if (!SWITCH_KINDS.includes(kind)) throw new Error(`未知推送类型: ${kind}`);
  const cur = await getSwitches(D1);
  cur[kind] = Boolean(on);
  await db.setState(D1, KEY, cur);
  return cur;
}

/** 某类推送是否开启（读失败时按「开」处理，宁可多推不要静默停摆） */
export async function isPushOn(D1, kind) {
  try {
    const s = await getSwitches(D1);
    return s[kind] !== false;
  } catch {
    return true;
  }
}
