/**
 * 能耗统计（D-091）
 * 口径：电耗率 = 耗电量 / 纯电里程；油耗率 = 耗油量 / 混动（发动机）里程。
 * 增程车的总里程里两套动力各跑一段，用「总里程」当分母会同时低估两者，所以分开算。
 */
import { round, num } from "./util.js";

/** 把 daily_stat 行聚合成一个区间的能耗汇总 */
export function aggregate(rows) {
  const agg = {
    days: 0, active_days: 0,
    travel_km: 0, elec_km: 0, hybrid_km: 0, ad_km: 0,
    elec_kwh: 0, fuel_l: 0, cost_cny: 0, fuel_cost_cny: 0, charge_kwh: 0, charge_times: 0,
  };
  for (const r of rows || []) {
    agg.days += 1;
    const km = num(r.travel_km, 0) || 0;
    if (km > 0) agg.active_days += 1;
    agg.travel_km += km;
    agg.elec_km += num(r.elec_km, 0) || 0;
    agg.hybrid_km += num(r.hybrid_km, 0) || 0;
    agg.ad_km += num(r.ad_km, 0) || 0;
    agg.elec_kwh += num(r.elec_kwh, 0) || 0;
    agg.fuel_l += num(r.fuel_l, 0) || 0;
    agg.cost_cny += num(r.cost_cny, 0) || 0;
    agg.fuel_cost_cny += num(r.fuel_cost_cny, 0) || 0;
    agg.charge_kwh += num(r.charge_kwh, 0) || 0;
    agg.charge_times += num(r.charge_times, 0) || 0;
  }
  return rates(agg);
}

/** 补上率值（每 100 km）与每公里成本；分母为 0 时给 null，不编造 0 */
export function rates(agg) {
  const out = { ...agg };
  out.elec_kwh_per_100km = agg.elec_km >= 1 ? round((agg.elec_kwh / agg.elec_km) * 100, 1) : null;
  out.fuel_l_per_100km = agg.hybrid_km >= 1 ? round((agg.fuel_l / agg.hybrid_km) * 100, 2) : null;
  out.total_cost = round((agg.cost_cny || 0) + (agg.fuel_cost_cny || 0), 2);
  out.cost_per_km = agg.travel_km >= 1 ? round(out.total_cost / agg.travel_km, 3) : null;
  out.pure_ratio = agg.travel_km >= 1 ? round((agg.elec_km / agg.travel_km) * 100, 1) : null;
  return out;
}

/** 变化百分比；基数为 0 或缺失时返回 null（不要显示 ∞%） */
export function deltaPct(cur, prev) {
  if (cur === null || cur === undefined || prev === null || prev === undefined) return null;
  const a = Number(cur), b = Number(prev);
  if (!isFinite(a) || !isFinite(b) || b === 0) return null;
  return round(((a - b) / Math.abs(b)) * 100, 1);
}

/** 能耗卡（文本指令 / 周报里的独立卡都能用） */
export function energySummaryText(e) {
  const bits = [];
  if (e.travel_km) bits.push(`里程 ${round(e.travel_km, 1)} km`);
  if (e.pure_ratio !== null) bits.push(`纯电占比 ${e.pure_ratio}%`);
  if (e.elec_kwh_per_100km !== null) bits.push(`电耗 ${e.elec_kwh_per_100km} kWh/100km`);
  if (e.fuel_l_per_100km !== null) bits.push(`油耗 ${e.fuel_l_per_100km} L/100km`);
  if (e.cost_per_km !== null) bits.push(`每公里 ¥${e.cost_per_km}`);
  return bits.join(" · ");
}

export const __test = { aggregate, rates, deltaPct, energySummaryText };
