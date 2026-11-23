// 飞书文本指令 / 卡片按钮 → 查询回卡（D-086）
//
// 设计约束（必须遵守）：
//  1) 只读：所有回答来自 D1 已采集的数据 + 高德逆地理（可选），**绝不调用任何车控接口**；
//  2) 只有绑定过的本人 open_id 能下指令，其他人静默忽略（避免被别人套取车辆位置）；
//  3) 单条指令最多 1 次飞书发送 + 少量 D1 读，不占采集链路；
//  4) 发不出去不影响主链路：所有异常在本模块内吞掉并记日志。
import * as db from "./db.js";
import * as cards from "./cards.js";
import { fuelSummary } from "./collector.js";
import { sendCard, sendText, updateCard } from "./feishu.js";
import { buildDetail, travelStatusText } from "./fields.js";
import { shanghaiNow, shanghaiDate, num, round, safeJson } from "./util.js";
import { summarizeRows, highlightsRows, __test as collectorTest } from "./collector.js";
import { lastWeekRange, lastMonthRange, monthRangeOf, monthBefore } from "./schedule.mjs";
import { regeo, hasKey as hasAmapKey } from "./amap.js";
import { signTripToken } from "./tripShare.js";
import { getSwitches, setSwitch, SWITCH_KINDS, SWITCH_LABELS } from "./pushswitch.js";
import { aggregate as energyAggregate, deltaPct, energySummaryText } from "./energy.js";

/** 常用按钮：指令卡/状态卡底部那排 */
//  D-179：按钮与常驻菜单三分类对齐（点一下就走，不占正文）
export const MENU_BUTTONS = [
  { text: "车况", cmd: "status", type: "primary" },
  { text: "电量续航", cmd: "battery" },
  { text: "今日", cmd: "today" },
  { text: "行程", cmd: "trip" },
  { text: "位置", cmd: "where" },
  { text: "充电情况", cmd: "charge" },
];

//  与飞书常驻菜单（19 个 event_key）同一套分类，用户在两处看到的是同一个结构（D-157/D-179）
export const MENU_GROUPS = [
  {
    title: "车辆状态",
    items: [
      ["车况", "实时状态卡"],
      ["电量续航", "电量 · 续航 · 油量"],
      ["位置", "车停在哪 · 距家多远"],
      ["充电情况", "在充就报状态，不在充给建议"],
      ["保养", "六项剩余里程"],
    ],
  },
  {
    title: "用车报告",
    items: [
      ["今日", "今天实时累计"],
      ["昨日", "昨天日小结"],
      ["本周", "本周至今"],
      ["上周", "上周汇总"],
      ["本月", "本月至今"],
      ["上月", "上月汇总"],
      ["能耗", "本月能耗率与每公里成本"],
      ["账单", "当月充电账单"],
      ["行程", "最近一条行程"],
    ],
  },
  {
    title: "更多信息",
    items: [
      ["指令菜单", "这张表"],
      ["推送开关", "12 类推送开关状态"],
      ["油价", "当前 95# 单价"],
      ["电价", "当前电价与分时表"],
      ["帮助", "官方客服电话"],
    ],
  },
];

const HELP_ROWS = [
  ["状态 / 车况", "实时状态卡（电量·续航·油量·胎压·门窗·温度）"],
  ["电量续航", "电量与续航卡"],
  ["今天 / 昨天", "日小结（今日为实时累计）"],
  ["日报 2026-11-01", "查指定日期日小结"],
  ["本周 / 周报", "本周至今 / 上周汇总"],
  ["本月 / 月报", "本月至今 / 上月汇总"],
  ["行程", "最近一条行程（含线路图链接）"],
  ["充电情况", "当前电量 + 是否建议充电（合并原「充电建议」）"],
  ["账单", "当月充电次数·电量·电费·平均单价"],
  ["位置", "车辆位置卡（地址 + 距家多远）"],
  ["能耗 / 电耗 / 油耗", "本月能耗率与每公里成本（对比上月）"],
  ["电价", "当前电价与它的来源（上次充电的实际价）"],
  ["保养", "六项保养剩余里程"],
  ["油价 / 油价 9.49", "查看 / 更新 95# 单价"],
  ["关闭 到家", "按类关推送：到家·行程·加油·异常·充电"],
  ["开启 行程", "重新打开某类推送"],
  ["帮助 / 客服", "理想官方客服电话与入口"],
  ["菜单 / 指令 / ?", "指令表（16 条）"],
];

/**
 * 从 VSS payload 里取值。
 *  坑（D-086）：理想有些 path 的 value 是 **JSON 字符串**（Maintain.* 六项、
 *   Location.CurrentLocationInfo 都是），不是对象 —— 必须再 parse 一次，
 *   否则 `v.maintainLeftMileage` 永远是 undefined（第一次做保养查询就踩到了）。
 */
function valOf(payload, path) {
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

function fmt(n, digits = 1, unit = "") {
  const x = Number(n);
  if (!Number.isFinite(x)) return "--";
  return x.toFixed(digits) + unit;
}

/** 当日实时累计（日汇总要等次日 00:10 才生成，白天只能从采样点算） */
async function partialDay(D1, vin, date) {
  const rows = await db.listSamplesBetween(D1, vin, `${date} 00:00:00`, `${date} 23:59:59`);
  if (!rows.length) return null;
  const first = rows[0];
  const last = rows[rows.length - 1];
  const km = Math.max(0, round(num(last.odometer_km) - num(first.odometer_km), 1));
  const up = await collectorTest.usagePrice(D1, vin, `${date} 23:59:59`);
  const kwhPerPct = up.kwh_per_pct || 0.31;
  const dPct = Math.max(0, num(first.battery) - num(last.battery));
  const kwh = round(dPct * kwhPerPct, 1);
  const trips = await db.listTripLogs(D1, vin, 50);
  const today = trips.filter((t) => String(t.started_at).slice(0, 10) === date);
  // D-130：今日卡不再展示「采样条数/电价/油价/统计口径」这类后端信息，
  //   改为展示用户真正关心的行程维度：首次出发、最后到达、最长一段。
  const longest = today.slice().sort((a, b) => Number(b.distance_km) - Number(a.distance_km))[0] || null;
  // D-131：今日有充电时，卡片要能体现「充了多少、花了多少、什么时候充的」
  const sess = await db.listChargeSessionsOnDate(D1, vin, date);
  const doneSess = sess.filter((x) => num(x.capacity_kwh) > 0.05);
  const charge = doneSess.length
    ? {
        times: doneSess.length,
        kwh: round(doneSess.reduce((a, x) => a + num(x.capacity_kwh), 0), 1),
        cost: round(doneSess.reduce((a, x) => a + num(x.cost_cny), 0), 2),
        price: (() => {
          const k = doneSess.reduce((a, x) => a + num(x.capacity_kwh), 0);
          const c = doneSess.reduce((a, x) => a + num(x.cost_cny), 0);
          return k > 0 ? c / k : null;
        })(),
        from: doneSess[0].started_at,
        to: doneSess[doneSess.length - 1].ended_at,
      }
    : null;
  return {
    date, samples: rows.length, from: first.sampled_at, to: last.sampled_at,
    km, kwh, cost: up.price != null ? round(kwh * up.price, 2) : 0,
    battery_from: num(first.battery), battery_to: num(last.battery),
    trips: today.length, price: up.price,
    first_start: today.length ? today[today.length - 1].started_at : null,
    last_end: today.length ? today[0].ended_at : null,
    longest: longest
      ? {
          km: num(longest.distance_km),
          from: longest.started_at,
          to: longest.ended_at,
          from_loc: cards.shortPlace(longest.start_loc || ""),
          to_loc: cards.shortPlace(longest.end_loc || ""),
        }
      : null,
    charge,
  };
}

function partialDayCard(p, fuelPrice, vehicle, icons) {
  //  D-130：今日小结 v3 —— 去掉后端信息（采样条数/电价/95#/统计口径），
  //   换成行程维度：首次出发、最后到达、最长一段、平均每段，让"今天怎么过的"一眼可读。
  const ic = (k) => (icons && icons[k]) || null;
  const clock = (ts) => String(ts || "").slice(11, 16);
  // 地名太长会把两行式撑成三行 → 截到 12 字
  const place = (x) => {
    const v = String(x || "").trim();
    return v.length > 20 ? `${v.slice(0, 20)}…` : v;
  };
  const perKm = p.km > 0.05 ? p.cost / p.km : null;
  const kwh100 = p.km > 0.05 ? (p.kwh / p.km) * 100 : null;
  const perTrip = p.trips > 0 ? p.km / p.trips : null;

  const detail = [
    kwh100 !== null ? cards.kvRow("平均电耗", cards.fmtNum(kwh100, "kWh/100km", 1)) : null,
    perKm !== null ? cards.kvRow("每公里成本", cards.fmtMoney(perKm)) : null,
    p.trips > 0 ? cards.kvRow("首次出发", clock(p.first_start)) : null,
    p.trips > 0 ? cards.kvRow("最后到达", clock(p.last_end)) : null,
    perTrip !== null ? cards.kvRow("平均每段", cards.fmtKmTrip(perTrip)) : null,
    // D-133：长文本一律压到最后——充电明细在前，最长一段行程（3 行）殿后
    p.charge ? cards.kvRow("今日充电", `${cards.fmtNum(p.charge.times, "次", 0)} · ${cards.fmtKwh(p.charge.kwh)}`) : null,
    p.charge ? cards.kvRow("充电花费", cards.fmtMoney(p.charge.cost)) : null,
    p.charge && p.charge.price != null ? cards.kvRow("充电单价", cards.fmtPrice(p.charge.price)) : null,
    p.charge && p.charge.from ? cards.kvRow("充电时段", `${clock(p.charge.from)} → ${clock(p.charge.to)}`) : null,
    p.longest
      ? cards.stackRow("最长一段行程", `${clock(p.longest.from)} → ${clock(p.longest.to)} · ${cards.fmtKmTrip(p.longest.km)}`)
      : null,
    p.longest && (p.longest.from_loc || p.longest.to_loc)
      ? cards.locRow(icons && icons.start, place(p.longest.from_loc) || "起点未记录")
      : null,
    p.longest && (p.longest.from_loc || p.longest.to_loc)
      ? cards.locRow(icons && icons.end, place(p.longest.to_loc) || "终点未记录")
      : null,
  ].filter(Boolean);

  // 标签只放"今天发生了什么"：几段行程 + 电量变化（原「实时累计」没有信息量，已删）
  // 标签顺序：今日充电（绿，最值得一眼看到）> 几段行程 > 电量变化
  const tags = [
    p.charge ? cards.textTag(`今日已充电 ${cards.fmtKwh(p.charge.kwh)}`, "green") : null,
    p.trips > 0 ? cards.textTag(`${cards.fmtNum(p.trips, "段", 0)}行程`, "wathet") : cards.textTag("今天还没动车", "wathet"),
    cards.textTag(`电量 ${cards.fmtPct(p.battery_from)} → ${cards.fmtPct(p.battery_to)}`, "wathet"),
  ].filter(Boolean).slice(0, 2);

  return cards.cardShell(
    "今日小结",
    `${cards.carName(vehicle)} · ${p.date}`,
    "今日实时累计",
    [
      cards.metricRow([
        cards.metricBlock("里程", cards.fmtKmTrip(p.km), ic("gauge_blue")),
        cards.metricBlock("耗电", cards.fmtKwh(p.kwh), ic("bolt_green")),
        cards.metricBlock("电费", cards.fmtMoney(p.cost), ic("coin")),
      ]),
      cards.collapsiblePanel(`更多数据 · ${detail.length} 项`, detail, { iconKey: ic("chevron") }),
    ],
    { template: "blue", tags },
  );
}

/** D-093：detail 已改存 runtime_state `last:detail`，sample.payload 不再带整包 VSS。
 *   D-096：这里原先直接 buildDetail(payload) → 卡片/文字回复里续航·油量·电压·胎压全是 `--`。 */
async function lastDetail(D1, s) {
  const cached = await db.getState(D1, "last:detail", null);
  return cached || buildDetail(safeJson(s?.payload, {}));
}

async function statusCard(env, D1, vin, vehicle) {
  const s = await db.lastSample(D1, vin);
  if (!s) return null;
  const health = await db.listHealth(D1, vin);
  const icons = await db.getState(D1, "card:icons", null);
  const card = cards.buildStatusCard({
    s: { ...s, detail: await lastDetail(D1, s) },
    trip: null,
    vehicle,
    health,
    icons,
  });
  return cards.withActions(card, MENU_BUTTONS);
}


async function tripCard(env, D1, vin) {
  const rows = await db.listTripLogs(D1, vin, 1);
  if (!rows.length) return null;
  // 与推送链路同一套口径（耗电/电费/油费都在 collector 里算，避免两处各算一遍）
  return await collectorTest.buildTripCardForPush(env, D1, vin, rows[0], null);
}

async function billsSummary(D1, vin, month) {
  const rows = (await db.listChargeSessions(D1, vin, 200))
    .filter((r) => String(r.started_at).slice(0, 7) === month);
  let kwh = 0, cost = 0, lastPrice = null;
  for (const r of rows) {
    kwh += num(r.capacity_kwh);
    cost += num(r.cost_cny);
    if (r.price_per_kwh != null) lastPrice = num(r.price_per_kwh);
  }
  return { month, sessions: rows.length, kwh: round(kwh, 2), cost: round(cost, 2), avg: kwh > 0 ? round(cost / kwh, 3) : lastPrice, rows };
}

/**
 * 位置卡取数（D-163）：地址走高德逆地理，围栏距离走 haversine。
 * 与 whereText() 同源，只是多了结构化字段给卡片用。
 */
async function whereCard(env, D1, vin, vehicle, icons) {
  const pos = await db.listRecentPositions(D1, vin, { limit: 1 });
  const p = pos[0];
  if (!p) return null;
  let address = "";
  if (hasAmapKey(env)) {
    try {
      const g = await regeo(env, { lat: num(p.lat), lon: num(p.lon) });
      address = g?.address || "";
    } catch { /* 逆地理失败就只显示坐标 */ }
  }
  const fences = [];
  try {
    const geos = await db.listGeofences(D1, vin);
    for (const g of geos) {
      const d = haversineM({ lat: num(p.lat), lon: num(p.lon) }, { lat: num(g.lat), lon: num(g.lon) });
      if (d < 3000) fences.push({ label: g.label, d, radius: num(g.radius_m, 400) });
    }
  } catch { /* 忽略 */ }
  fences.sort((a, b) => a.d - b.d);
  const s = await db.lastSample(D1, vin);
  const detail = s ? await lastDetail(D1, s) : {};
  const travelText = detail.travel_status != null
    ? travelStatusText(detail.travel_status)
    : (detail.travel_status_text || "");
  return cards.buildLocationCard({
    address,
    lat: num(p.lat),
    lon: num(p.lon),
    at: p.sampled_at,
    fences,
    travelText,
    battery: s?.battery ?? null,
    vehicle,
    icons,
  });
}

/** 保养卡取数（D-163）：六项来自 last:detail.maint（D-162 起在采集时抽好）。 */
async function maintCard(D1, vin, vehicle, icons) {
  const s = await db.lastSample(D1, vin);
  if (!s) return null;
  const detail = await lastDetail(D1, s);
  const maint = detail?.maint || null;
  if (!maint || !Object.keys(maint).length) return null;
  return cards.buildMaintCard({ maint, odoKm: s.odometer_km, vehicle, icons });
}

async function whereText(env, D1, vin) {
  const pos = await db.listRecentPositions(D1, vin, { limit: 1 });
  const p = pos[0];
  if (!p) return "还没有位置数据（位置采集 2026-11-03 起才有）。";
  const lines = [`**${fmt(p.lat, 4)}, ${fmt(p.lon, 4)}**`, `采样时间 ${p.sampled_at}`];
  if (hasAmapKey(env)) {
    try {
      const g = await regeo(env, { lat: num(p.lat), lon: num(p.lon) });
      if (g?.address) lines.unshift(`**${g.address}**`);
    } catch (err) {
      lines.push(`（逆地理失败：${String(err?.message || err).slice(0, 60)}）`);
    }
  }
  // 距最近的围栏中心多远
  try {
    const geos = await db.listGeofences(D1, vin);
    for (const g of geos) {
      const d = haversineM({ lat: num(p.lat), lon: num(p.lon) }, { lat: num(g.lat), lon: num(g.lon) });
      if (d < 3000) lines.push(`距「${g.label}」约 **${Math.round(d)} m**（围栏半径 ${Math.round(num(g.radius_m, 400))} m）`);
    }
  } catch { /* 忽略 */ }
  lines.push("（坐标已按 WGS-84 原样显示；叠高德底图需转 GCJ-02）");
  return lines.join("\n");
}

function haversineM(a, b) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function maintainText(D1, vin) {
  // D-162：保养数据在 detail.maint（采集时从 VSS 的 JSON 字符串抽出来），
  // 老版本从 sample.payload 读，但 payload 自 D-093 起是空对象 → 一直是「还没采到」。
  const detail = await db.getState(D1, "last:detail", null);
  const s = await db.lastSample(D1, vin);
  const p = safeJson(s?.payload, {}) || {};
  const items = [
    ["增程器机油", "enginelevel1", "Vehicle.Carcenter.Maintain.enginelevel1"],
    ["增程器机滤", "enginelevel2", "Vehicle.Carcenter.Maintain.enginelevel2"],
    ["空调滤芯", "acfilter", "Vehicle.Carcenter.Maintain.acfilter"],
    ["火花塞", "sparkplug", "Vehicle.Carcenter.Maintain.sparkplug"],
    ["冷却液", "coolfuild", "Vehicle.Carcenter.Maintain.coolfuild"],
    ["齿轮/刹车油", "gearbrakeoil", "Vehicle.Carcenter.Maintain.gearbrakeoil"],
  ];
  const lines = ["**保养剩余**"];
  for (const [label, key, path] of items) {
    let left = detail?.maint?.[key]?.left ?? null;
    let period = detail?.maint?.[key]?.period ?? null;
    let byEngine = detail?.maint?.[key]?.byEngine ?? false;
    if (left === null) {
      // 兼容：万一 detail 里没有（老数据），再从 payload 试一次
      const v = valOf(p, path);
      if (v && typeof v === "object") {
        left = num(v.maintainLeftMileage, null);
        period = num(v.periodMileage, null);
        byEngine = String(v.mileageSource || "") === "engine";
      }
    }
    if (left === null) continue;
    const src = byEngine ? "增程器里程" : "总里程";
    lines.push(`· ${label}：剩 **${Math.round(left)} km**（周期 ${period ?? "--"} km · 按${src}计）`);
  }
  if (lines.length === 1) lines.push("（还没采到保养数据）");
  return lines.join("\n");
}

/** 统一出口：卡片或文本都发到同一个会话 */
async function reply(env, target, payload) {
  if (!target) return { ok: false, msg: "还没绑定推送目标" };
  if (typeof payload === "string") return sendText(env, target, payload);
  return sendCard(env, target, payload);
}

/**
 * 处理一条文本指令。
 * @returns {Promise<{handled:boolean, kind?:string, ok?:boolean, msg?:string}>}
 */
//  D-152：飞书「机器人自定义菜单」点击事件（application.bot.menu_v6）的白名单。
//   event_key 是后台配置菜单项时手填的「唯一标识」，1~30 字符；这里只认这几个，
//   其它一律回「菜单」卡（不给未知 key 留任何执行入口）。
export const BOT_MENU_KEYS = {
  // 一、车辆状态
  veh_status: "车况",
  //  D-163：电量与续航合并成一张卡，两个 key 都指向它（后台配哪个都能用）
  veh_battery: "电量续航",
  veh_range: "电量续航",
  veh_where: "位置",
  veh_charge: "充电情况",
  veh_maint: "保养",
  // 二、用车报表
  rep_today: "今天",
  rep_yesterday: "昨天",
  rep_week: "本周",
  rep_week_last: "上周",
  rep_month: "本月",
  rep_month_last: "上月",
  rep_energy: "能耗",
  rep_bills: "账单",
  // 三、行程与充电
  trip_latest: "行程",
  // 「充电建议」已并入「充电情况」（D-161），保留旧 key 兼容
  trip_advice: "充电情况",
  trip_fuelprice: "油价",
  trip_elecprice: "电价",
  // 四、帮助与设置
  help_menu: "菜单",
  help_push: "推送",
  help_help: "帮助",
  // 兼容最早的一版短 key（后台若已按短 key 配过，不用改）
  status: "车况", today: "今日", trip: "行程", where: "位置",
  charge: "充电", energy: "能耗", menu: "菜单", help: "菜单",
};

// 菜单点击 → 复用文字指令路由（同一条链路，不复制任何业务逻辑）。
// 安全：只认已绑定车主（D-086），非车主静默忽略；不访问网络/不写库，回调路径零 I/O。
export async function handleBotMenu(env, { openId = null, eventKey = "" } = {}) {
  const target = await db.getState(env.DB, "feishu:target");
  if (!target?.id) {
    console.warn("[bot-menu] 还没有绑定推送目标，忽略");
    return { ok: false, reason: "no_target" };
  }
  if (openId && openId !== target.id) {
    console.warn("[bot-menu] 忽略非车主菜单点击:", openId);
    return { ok: false, reason: "not_owner" };
  }
  const key = String(eventKey || "").trim().toLowerCase();
  const text = BOT_MENU_KEYS[key] || "菜单";
  const r = await handleTextCommand(env, { text, chatId: null });
  if (!r?.handled) {
    //  D-164 踩坑：菜单 key 指向的「指令文本」必须能被指令分支识别。
    //  veh_battery 曾经映射到「电量续航」，而电量分支只认「电量/续航」→ handled:false，
    //  于是点了没任何反应（前端看不到任何错误）。这里兜一层：识别不了就回菜单卡，至少不静默。
    console.warn("[bot-menu] 指令文本未识别，回落菜单卡:", key, text);
    try {
      const v = await db.getVehicle(D1).catch(() => null);
      await sendCard(env, target, cards.buildMenuCard({
        groups: MENU_GROUPS, buttons: MENU_BUTTONS, vehicle: v,
      }));
    } catch { /* 兜底失败也不影响事件返回 */ }
    return { ok: true, key, text, handled: false, fallback: "menu" };
  }
  return { ok: true, key, text, handled: true };
}

export async function handleTextCommand(env, { text, chatId = null, dryRun = false }) {
  const D1 = env.DB;
  let cardOut = null;
  const raw = String(text || "").trim();
  if (!raw) return { handled: false };
  // 去掉前导 / 或 ！，统一小写化（中文不受影响）
  const cmdline = raw.replace(/^[/!！]\s*/, "");
  const lower = cmdline.toLowerCase();
  const vehicle = await db.getVehicle(D1);
  if (!vehicle) return { handled: false, msg: "车辆信息未初始化" };
  const vin = vehicle.vin;
  const target = chatId ? { type: "chat_id", id: chatId } : await db.getState(D1, "feishu:target");
  const fuelPrice = await db.currentFuelPrice(D1);

  const eq = (...names) => names.some((n) => lower === n);
  const starts = (...names) => names.some((n) => lower.startsWith(n));

  let payload = null;
  let kind = "";

  try {
    if (eq("帮助", "客服", "电话", "help")) {
      //  D-164：帮助不再和「指令菜单」重复，改成官方客服卡
      kind = "help";
      const card = cards.buildSupportCard({ vehicle, icons: await db.getState(D1, "card:icons", null) });
      if (dryRun) payload = card;
      else { payload = "帮助与客服"; cardOut = card; }
    } else if (eq("菜单", "指令", "menu", "?", "？", "指令菜单", "菜单卡", "指令表")) {
      kind = "help";
      payload = cards.buildMenuCard({ groups: MENU_GROUPS, buttons: MENU_BUTTONS, vehicle });
    } else if (eq("状态", "车况", "车辆状态", "status", "s")) {
      kind = "status";
      payload = await statusCard(env, D1, vin, vehicle);
      if (!payload) payload = "还没有采集数据，稍等一分钟再试。";
    } else if (eq("电量", "电池", "soc", "battery", "续航", "range", "电量续航")) {
      //  D-163：电量与续航合并成一张卡（两条指令都进这里）
      kind = "battery";
      const s = await db.lastSample(D1, vin);
      if (!s) payload = "还没有采集数据，稍等一分钟再试。";
      else {
        const d = await lastDetail(D1, s);
        const card = cards.buildBatteryCard({
          battery: s.battery,
          rangeElec: d.range_elec ?? s.range_km,
          rangeFuel: d.range_fuel,
          fuelLevel: d.fuel_level,
          packVoltage: d.pack_voltage,
          charging: Boolean(s.charging),
          chargeStatusText: d.charge_status_text,
          vehicle,
          icons: await db.getState(D1, "card:icons", null),
          at: s.sampled_at,
        });
        if (dryRun) payload = card;
        else { payload = "电量续航"; cardOut = card; }
      }
    } else if (eq("今天", "今日", "today")) {
      kind = "today";
      const p = await partialDay(D1, vin, shanghaiDate());
      payload = p
        ? partialDayCard(p, fuelPrice, vehicle, await db.getState(D1, "card:icons", null))
        : "今天还没有采样数据。";
    } else if (eq("昨天", "昨日", "yesterday")) {
      kind = "yesterday";
      const date = shanghaiDate(new Date(Date.now() - 24 * 3600 * 1000));
      const row = await db.getDaily(D1, vin, date);
      if (row) {
        const up = await collectorTest.usagePrice(D1, vin, `${date} 23:59:59`);
        payload = cards.buildDailyCard({
          d: row, vehicle, priceCny: up.price, fuelPriceCny: fuelPrice, dateLabel: date,
          priceNote: up.at ? `按 ${String(up.at).slice(5, 16)} 那次充电的电价` : "按默认电价",
          icons: await db.getState(D1, "card:icons", null),
        });
      } else {
        const p = await partialDay(D1, vin, date);
        payload = p
          ? partialDayCard(p, fuelPrice, vehicle, await db.getState(D1, "card:icons", null))
          : `${date} 没有数据。`;
      }
    } else if (starts("日报", "日结", "daily")) {
      kind = "daily";
      const arg = cmdline.replace(/^(日报|日结|daily)\s*/i, "").trim();
      const date = /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : shanghaiDate(new Date(Date.now() - 24 * 3600 * 1000));
      const row = await db.getDaily(D1, vin, date);
      if (!row) payload = `${date} 还没有日汇总（该天可能没采集到）。`;
      else {
        const up = await collectorTest.usagePrice(D1, vin, `${date} 23:59:59`);
        payload = cards.buildDailyCard({
          d: row, vehicle, priceCny: up.price, fuelPriceCny: fuelPrice, dateLabel: date,
          priceNote: up.at ? `按 ${String(up.at).slice(5, 16)} 那次充电的电价` : "按默认电价",
          icons: await db.getState(D1, "card:icons", null),
        });
      }
    } else if (eq("本周", "thisweek")) {
      kind = "thisweek";
      const today = shanghaiDate();
      const d = new Date(Date.now() + 8 * 3600 * 1000);
      const dow = (d.getUTCDay() + 6) % 7; // 周一=0
      const monday = shanghaiDate(new Date(Date.now() - dow * 24 * 3600 * 1000));
      const rows = await db.listDaily(D1, vin, monday, today);
      const up = await collectorTest.usagePrice(D1, vin, `${today} 23:59:59`);
      payload = rows.length
        ? cards.buildWeeklyCard({
            summary: summarizeRows(rows), days: rows, weekLabel: `${monday} ~ ${today}（本周至今）`,
            highlights: highlightsRows(rows), energy: energyAggregate(rows),
            vehicle, priceCny: up.price, icons: await db.getState(D1, "card:icons", null),
            title: "本周用车小结",
          })
        : "本周还没有日汇总数据。";
    } else if (eq("周报", "上周", "weekly")) {
      kind = "weekly";
      const { from, to } = lastWeekRange(new Date());
      const rows = await db.listDaily(D1, vin, from, to);
      const up = await collectorTest.usagePrice(D1, vin, `${to} 23:59:59`);
      const prevRows = await db.listDaily(D1, vin, shanghaiDate(new Date(Date.parse(`${from}T00:00:00Z`) - 7 * 86400000)), shanghaiDate(new Date(Date.parse(`${from}T00:00:00Z`) - 86400000)));
      payload = rows.length
        ? cards.buildWeeklyCard({
            summary: summarizeRows(rows), days: rows, weekLabel: `${from} ~ ${to}`,
            highlights: highlightsRows(rows), energy: energyAggregate(rows), prev: energyAggregate(prevRows),
            vehicle, priceCny: up.price, icons: await db.getState(D1, "card:icons", null),
          })
        : `${from} ~ ${to} 没有数据。`;
    } else if (eq("本月", "thismonth")) {
      kind = "thismonth";
      const today = shanghaiDate();
      const month = today.slice(0, 7);
      const rows = await db.listDaily(D1, vin, `${month}-01`, today);
      const pmRange = monthRangeOf(monthBefore(month));
      const pmRows = await db.listDaily(D1, vin, pmRange.from, pmRange.to);
      const upM = await collectorTest.usagePrice(D1, vin, `${today} 23:59:59`);
      payload = rows.length
        ? cards.buildMonthlyCard({
            summary: summarizeRows(rows), days: rows, monthLabel: `${month}（本月至今）`,
            highlights: highlightsRows(rows), fuel: await fuelSummary(D1, vin, `${month}-01`, today),
            vehicle, priceCny: upM.price, icons: await db.getState(D1, "card:icons", null),
            prev: summarizeRows(pmRows), title: "本月用车小结",
          })
        : "本月还没有日汇总数据。";
    } else if (eq("月报", "上月", "monthly")) {
      kind = "monthly";
      const { from, to, month } = lastMonthRange(new Date());
      const rows = await db.listDaily(D1, vin, from, to);
      const pmRange = monthRangeOf(monthBefore(month));
      const pmRows = await db.listDaily(D1, vin, pmRange.from, pmRange.to);
      const upM = await collectorTest.usagePrice(D1, vin, `${to} 23:59:59`);
      payload = rows.length
        ? cards.buildMonthlyCard({
            summary: summarizeRows(rows), days: rows, monthLabel: month,
            highlights: highlightsRows(rows), fuel: await fuelSummary(D1, vin, from, to),
            vehicle, priceCny: upM.price, icons: await db.getState(D1, "card:icons", null),
            prev: summarizeRows(pmRows), title: "上月用车小结",
          })
        : `${month} 没有数据。`;
    } else if (eq("能耗", "电耗", "油耗", "energy")) {
      kind = "energy";
      const today = shanghaiDate();
      const month = today.slice(0, 7);
      const rows = await db.listDaily(D1, vin, `${month}-01`, today);
      const e = energyAggregate(rows);
      const lastMonth = lastMonthRange(new Date());
      const prevRows = await db.listDaily(D1, vin, lastMonth.from, lastMonth.to);
      const prev = energyAggregate(prevRows);
      if (!e.travel_km) payload = "本月还没有里程数据。";
      else {
        const dKm = deltaPct(e.travel_km, prev.travel_km);
        const dElec = deltaPct(e.elec_kwh_per_100km, prev.elec_kwh_per_100km);
        payload = cards.buildNoticeCard({
          title: "能耗小结",
          subtitle: `${month}（本月至今）`,
          template: "turquoise",
          rows: [
            { label: "里程", value: `${round(e.travel_km, 1)} km（纯电 ${round(e.elec_km, 1)} / 发动机 ${round(e.hybrid_km, 1)}）` },
            { label: "纯电占比", value: e.pure_ratio !== null ? `${e.pure_ratio}%` : "--" },
            { label: "电耗", value: e.elec_kwh_per_100km !== null ? `${e.elec_kwh_per_100km} kWh/100km` : "本月未用纯电" },
            { label: "油耗", value: e.fuel_l_per_100km !== null ? `${e.fuel_l_per_100km} L/100km` : "本月未用油" },
            { label: "每公里成本", value: e.cost_per_km !== null ? `¥${e.cost_per_km}` : "--" },
            { label: "vs 上月", value: `${dKm === null ? "--" : `${dKm > 0 ? "+" : ""}${dKm}% 里程`}${dElec === null ? "" : ` · 电耗 ${dElec > 0 ? "+" : ""}${dElec}%`}` },
          ],
          footNote: "电耗率按纯电里程、油耗率按发动机里程分别计算（增程车两套动力各自分母）",
        });
      }
    } else if (eq("充电情况", "充电建议", "充电提醒", "charge_state", "advice")) {
      //  D-163：裸「充电」改回「最近充电流水」（见下面 charge 分支）；
      //  「充电情况」= 当前状态 + 建议（D-161），两者不要抢同一个词。
      // D-161：用户要求「充电」与「充电建议」合并成一张卡——正在充电就报充电情况，
      // 没充电就报电量情况 + 给不给充电建议。分开的两条指令容易点错，也没有信息增量。
      kind = "charge_state";
      const s2 = await db.lastSample(D1, vin);
      if (!s2) payload = "还没有采集数据，稍等一分钟再试。";
      else {
        const d2 = await lastDetail(D1, s2);
        const battery = num(s2.battery, null);
        const rangeKm = num(d2.range_elec, num(s2.range_km, null));
        const charging = Boolean(s2.charging);
        const power = num(d2.charge_power, null);
        let advice = null;
        if (!charging) {
          // 优先用推送同款建议（低电 + 在家 + 非谷时才返回）；
          // 不满足条件时也补一份「电量充足/暂不建议」的口径，保证第三块永远有结论。
          advice = await collectorTest.chargeAdvice(D1, vin, {
            battery, charging, range_km: rangeKm,
            position: s2.payload ? (safeJson(s2.payload, {}).position || null) : null,
          });
          if (!advice) {
            let nowPrice = null, valleyPrice = null, valleyWindow = null, inValley = false;
            try {
              const tiers = await db.listElecTiers(D1);
              if (tiers && tiers.length) {
                nowPrice = await db.elecTierPriceAt(D1, shanghaiNow());
                const cheapest = tiers.reduce((a, b) => (Number(b.price) < Number(a.price) ? b : a), tiers[0]);
                valleyPrice = Number(cheapest.price);
                valleyWindow = cheapest.from && cheapest.to ? `${cheapest.from}~${cheapest.to}` : null;
                inValley = nowPrice !== null && Math.abs(Number(nowPrice) - valleyPrice) < 0.02;
              }
            } catch { /* 电价拿不到就不显示，不影响第一二块 */ }
            advice = { battery, rangeKm, nowPrice: nowPrice === null ? null : Number(nowPrice), valleyPrice, valleyWindow,
                       needKwh: null, saveCny: null, inValley, plenty: battery !== null && battery > 50 };
          }
        }
        const card = cards.buildChargeStatusCard({
          charging, battery, rangeKm, power,
          chargeStatusText: d2.charge_status_text || null,
          advice, vehicle, at: s2.sampled_at,
          icons: await db.getState(D1, "card:icons", null),
        });
        if (dryRun) payload = card;
        else { payload = "充电情况"; cardOut = card; }
      }
    } else if (eq("行程", "最近行程", "trip")) {
      kind = "trip";
      payload = (await tripCard(env, D1, vin)) || "还没有记录到行程（里程 >0.5 km 且停车 6 分钟才算一段）。";
    } else if (eq("充电", "充电记录", "charge")) {
      //  D-163：最近充电流水 → 三块摘要 + table 明细
      kind = "charge";
      const rows = await db.listChargeSessions(D1, vin, 5);
      const card = cards.buildChargeHistoryCard({ rows, vehicle, icons: await db.getState(D1, "card:icons", null) });
      if (dryRun) payload = card;
      else { payload = "最近充电"; cardOut = card; }
    } else if (eq("账单", "电费", "bills")) {
      //  D-163：当月充电账单 → 三块指标卡
      kind = "bills";
      const month = shanghaiDate().slice(0, 7);
      const b = await billsSummary(D1, vin, month);
      const card = cards.buildBillsCard({
        month, sessions: b.sessions, kwh: b.kwh, cost: b.cost, avg: b.avg,
        vehicle, icons: await db.getState(D1, "card:icons", null),
      });
      if (dryRun) payload = card;
      else { payload = "充电账单"; cardOut = card; }
    } else if (eq("位置", "在哪", "车在哪", "where")) {
      kind = "where";
      const lc = await whereCard(env, D1, vin, vehicle, await db.getState(D1, "card:icons", null));
      if (!lc) payload = await whereText(env, D1, vin);
      else if (dryRun) payload = lc;
      else { payload = "车辆位置"; cardOut = lc; }
    } else if (eq("保养", "maintain")) {
      kind = "maintain";
      const mc = await maintCard(D1, vin, vehicle, await db.getState(D1, "card:icons", null));
      if (!mc) payload = await maintainText(D1, vin);
      else if (dryRun) payload = mc;
      else { payload = "保养剩余"; cardOut = mc; }
    } else if (starts("油价")) {
      kind = "fuelprice";
      const arg = cmdline.replace(/^油价\s*/i, "").trim();
      if (!arg) {
        const row = await db.currentFuelPriceRow(D1);
        const card = cards.buildFuelPriceCard({
          price: row ? num(row.price_cny) : (fuelPrice != null ? Number(fuelPrice) : null),
          updatedAt: row ? row.effective_from : null,
          vehicle, icons: await db.getState(D1, "card:icons", null),
        });
        if (dryRun) payload = card;
        else { payload = "油价"; cardOut = card; }
      } else if (/^\d+(\.\d{1,2})?$/.test(arg) && Number(arg) >= 4 && Number(arg) <= 20) {
        await db.setFuelPrice(D1, Number(arg));
        payload = `油价已更新为 **¥${fmt(arg, 2)}/L**（95#）`;
      } else {
        payload = "价格看起来不对，格式示例：「油价 9.49」（4~20 元/升）。";
      }
    } else if (eq("电价", "当前电价", "elecprice")) {
      //  D-163：当前电价 → 卡片（口径与电费一致：沿用上次充电的实际电价，D-078）
      kind = "elecprice";
      const veh = await db.getVehicle(D1);
      const row = veh?.vin ? await db.lastChargePrice(D1, veh.vin) : null;
      if (!row) {
        payload = "还没有充电记录，暂时没有电价。";
      } else {
        let valleyPrice = null, valleyWindow = null;
        try {
          const tiers = await db.listElecTiers(D1);
          if (tiers.length) {
            const min = tiers.reduce((a, t) => (t.price < a.price ? t : a));
            valleyPrice = min.price;
            if (min.from && min.to) valleyWindow = `${String(min.from).slice(0, 5)}~${String(min.to).slice(0, 5)}`;
          }
        } catch { /* 没配置分时电价就只显示一个价 */ }
        const card = cards.buildElecPriceCard({
          price: num(row.price_per_kwh),
          at: row.started_at,
          kwh: row.capacity_kwh != null ? num(row.capacity_kwh) : null,
          valleyPrice, valleyWindow,
          vehicle, icons: await db.getState(D1, "card:icons", null),
        });
        if (dryRun) payload = card;
        else { payload = "当前电价"; cardOut = card; }
      }
    } else if (eq("推送", "开关", "推送开关", "push", "switches")) {
      //  D-154：常驻菜单「推送开关」入口需要一条只读指令；以前只有「关闭 X / 开启 X」。
      kind = "pushswitch";
      //  D-158：改成可点的卡片（11 个按钮），文字只在 dry_run/降级时用
      const cur = await getSwitches(D1);
      cardOut = cards.buildSwitchCard({ switches: cur, kinds: SWITCH_KINDS, labels: SWITCH_LABELS, vehicle });
      payload = "**推送开关**\n" +
        SWITCH_KINDS.map((k) => `${SWITCH_LABELS[k]}：${cur[k] ? "开启" : "关闭"}`).join("\n");
    } else if (/^(关闭|开启|关掉|打开)\s*(.+)$/.test(cmdline)) {
      kind = "switch";
      const m = cmdline.match(/^(关闭|开启|关掉|打开)\s*(.+)$/);
      const on = m[1] === "开启" || m[1] === "打开";
      const want = m[2].trim();
      const hit = SWITCH_KINDS.find((k) => want.includes(k) || want.includes(SWITCH_LABELS[k]) ||
        SWITCH_LABELS[k].includes(want) || want.includes(SWITCH_LABELS[k].split("/")[0]));
      if (!hit) {
        payload = `没认出来要${on ? "开" : "关"}哪一类。可用：${SWITCH_KINDS.map((k) => `${SWITCH_LABELS[k]}（${k}）`).join("、")}`;
      } else {
        const cur = await setSwitch(D1, hit, on);
        //  D-163：开关类指令直接回「推送开关卡」（状态已更新），可以接着点下一项
        cardOut = cards.buildSwitchCard({ switches: cur, kinds: SWITCH_KINDS, labels: SWITCH_LABELS, vehicle });
        payload = `${on ? "已开启" : "已关闭"}「${SWITCH_LABELS[hit]}」推送\n当前：` +
          SWITCH_KINDS.map((k) => `${SWITCH_LABELS[k]}${cur[k] ? "已开" : "已关"}`).join(" · ");
      }
    } else {
      return { handled: false };
    }
  } catch (err) {
    return { handled: true, kind, ok: false, msg: String(err?.message || err).slice(0, 200) };
  }

  if (dryRun) return { handled: true, kind, ok: true, payload, card: cardOut };
  if (cardOut) {
    const cr = await sendCard(env, target, cardOut);
    return { handled: true, kind, ok: cr?.ok !== false, msg: cr?.msg || "success" };
  }
  const res = await reply(env, target, payload);
  return { handled: true, kind, ok: res?.ok !== false, msg: res?.msg || "success" };
}

/**
 * 处理卡片按钮回调（event_type = card.action.trigger）
 * 飞书要求返回 {toast, card?}；这里只回 toast，实际结果用新消息发出。
 */
/**
 * 卡片按钮回调：拆成「先回 toast」+「异步干活」两步。
 *
 *  为什么拆（D-086 修复，飞书报 code 200341）：
 *   飞书要求卡片回调 **3 秒内**返回，否则会重试 3 次并给用户弹「出错了，请稍后重试」。
 *   我们原来在响应前同步 sendCard（一次飞书 API 就要几百毫秒到 1 秒多），
 *   叠加冷启动/DB 查询很容易超时 —— 线上实测同一张卡的点击被飞书连发了 3 次回调。
 *   现在 planCardAction 只做解析 + 一次 DB 读（约 10~30 ms）就返回 toast，
 *   真正的查询与发卡交给 runCardAction 在 waitUntil 里跑。
 */
export function planCardAction(body) {
  const ev = body?.event || {};
  const value = ev?.action?.value || {};
  const openId = ev?.operator?.open_id || null;
  const chatId = ev?.context?.open_chat_id || null;
  const cmd = String(value.cmd || "").trim();
  const arg = value.arg == null ? "" : String(value.arg);

  //  D-146：加油卡内嵌 form 提交（本次油价）——不碰 DB，直接交给 async 执行
  const formValue = ev?.action?.form_value;
  if (formValue && typeof formValue === "object" && formValue.price != null) {
    return {
      run: true,
      kind: "fuel_price",
      price: Number(String(formValue.price).replace(/[¥￥\s元]/g, "")),
      openId,
      eventId: String(body?.header?.event_id || ""),
      chatId,
      toast: { type: "success", content: "正在记录油价…" },
    };
  }

  //  D-158：推送开关卡按钮 → 切换某个开关 + 原地更新卡片
  if (value.toggle) {
    return {
      run: true,
      kind: "push_toggle",
      switchKind: String(value.toggle),
      openId,
      eventId: String(body?.header?.event_id || ""),
      chatId,
      msgId: ev?.context?.open_message_id || null,
      toast: { type: "success", content: "已切换" },
    };
  }

  if (!cmd) {
    return { run: false, toast: { type: "info", content: "这个按钮还没有绑定动作" } };
  }
  // 车主校验放到 runCardAction 里做：回调响应路径上**一次 D1 都不碰**，
  // 才能稳定在飞书的 3 秒窗口内（实测每碰一次 D1 就多 300~500 ms）。
  return {
    run: true,
    openId,
    eventId: String(body?.header?.event_id || ""),
    text: arg ? `${cmd} ${arg}` : cmd,
    chatId,
    toast: { type: "success", content: "已发送" },
  };
}

/** 真正执行按钮对应的指令（在 waitUntil 里跑，失败只记日志，不影响已返回的 toast） */
export async function runCardAction(env, plan) {
  try {
    //  幂等：飞书在超时会用同一个 event_id 重试 3 次，不去重就会重复发卡（D-087）
    if (plan.eventId) {
      const seenKey = `card:evt:${plan.eventId}`;
      const seen = await db.getState(env.DB, seenKey);
      if (seen) {
        console.warn("[card-action] 重复回调，已忽略:", plan.eventId);
        return { ok: true, msg: "duplicate", kind: null };
      }
      await db.setState(env.DB, seenKey, { at: shanghaiNow(), text: plan.text });
    }
    const owner = await db.getState(env.DB, "feishu:target");
    if (owner && plan.openId && plan.openId !== owner.id) {
      console.warn("[card-action] 忽略非车主点击:", plan.openId);
      await db.setState(env.DB, "card:last", {
        text: plan.text, ok: false, kind: null, msg: "foreign_open_id", at: shanghaiNow(),
      }).catch(() => {});
      return { ok: false, msg: "只有车主本人可以使用" };
    }
    //  D-158：推送开关按钮 —— 翻转开关后原地 PATCH 这张卡（失败则补发一张新卡）
    if (plan.kind === "push_toggle") {
      const before = await getSwitches(env.DB);
      const on = !before[plan.switchKind];
      const cur = await setSwitch(env.DB, plan.switchKind, on);
      const vehicle = await db.getVehicle(env.DB).catch(() => null);
      const card = cards.buildSwitchCard({ switches: cur, kinds: SWITCH_KINDS, labels: SWITCH_LABELS, vehicle });
      let updated = false;
      if (plan.msgId) {
        const r = await updateCard(env, plan.msgId, card).catch(() => ({ ok: false }));
        updated = !!r.ok;
      }
      if (!updated) {
        const target = plan.chatId ? { type: "chat_id", id: plan.chatId } : { type: "open_id", id: plan.openId };
        await sendCard(env, target, card).catch(() => {});
      }
      await db.setState(env.DB, "card:last", {
        text: `${on ? "开启" : "关闭"} ${SWITCH_LABELS[plan.switchKind] || plan.switchKind}`,
        ok: true, kind: "push_toggle", msg: updated ? "card-updated" : "card-resent", at: shanghaiNow(),
      }).catch(() => {});
      return { ok: true, kind: "push_toggle", msg: updated ? "card-updated" : "card-resent" };
    }

    if (plan.kind === "fuel_price") {
      const r = await finishFuelPrice(env, plan.price);
      if (!r.ok) {
        // 失败必须有可见反馈：toast 是乐观文案，异步失败不告诉用户等于静默丢弃
        await sendText(env, plan.chatId ? { type: "chat_id", id: plan.chatId } : { type: "open_id", id: plan.openId },
          `没记上本次油价：${r.msg}`).catch(() => {});
      }
      try {
        await db.setState(env.DB, "card:last", {
          text: `油价 ${plan.price}`, ok: r.ok, kind: "fuel_price",
          msg: String(r.msg || "").slice(0, 80), at: shanghaiNow(),
        });
      } catch { /* ignore */ }
      return r;
    }
    const r = await handleTextCommand(env, { text: plan.text, chatId: plan.chatId });
    if (r.ok === false) console.error("[card-action] 指令执行失败:", plan.text, r.msg);
    // 留一条可观测记录：waitUntil 里跑的东西没有响应体可看，出问题只能靠这个回溯
    try {
      await db.setState(env.DB, "card:last", {
        text: plan.text, ok: r.ok !== false, kind: r.kind || null,
        msg: String(r.msg || "").slice(0, 80), at: shanghaiNow(),
      });
    } catch { /* 记录失败不影响结果 */ }
    return r;
  } catch (err) {
    console.error("[card-action] 异常:", plan.text, err?.message);
    return { ok: false, msg: err?.message || "error" };
  }
}

/**
 * 记下本次油价（D-146）：卡片 form 提交和文字回复「9.49」都走这里。
 *   - 写 price_rule(scope='fuel')：所有油费口径（日报/周报/月报行驶电费、行程卡本程油费、面板）都读它
 *   - 有 message_id 就**原地更新**那张加油卡成「已完成 · 已记录」，不再发新消息
 *   - 没有 message_id（旧版卡/文字触发）退回文字确认
 */
async function finishFuelPrice(env, price) {
  const D1 = env.DB;
  if (!Number.isFinite(price) || !(price >= 4 && price <= 20)) {
    return { ok: false, msg: "价格要在 4~20 元/升之间" };
  }
  const pending = await db.getState(D1, "fuel:pending_price");
  if (!pending || !pending.at) return { ok: false, msg: "没有待记录的加油" };

  // 仅「调试入口（/api/test-push）造的卡」带 test:true，跳过写价（那时填的是假数字，D-147）；
  // 真实加油链路（collector 写 fuel:pending_price）不带 test，这里一定会写 price_rule。
  const liters = Number(pending.liters);
  const cost = Number.isFinite(liters) ? round(liters * price, 2) : null;
  if (!pending.test) {
    await db.setFuelPrice(D1, price);
    // 加油记录入库时用的是「当时的有效油价」，这里补回写真实单价与金额（D-182）
    if (pending.at) {
      try {
        const vehicle = await db.getVehicle(D1);
        await db.updateFuelLogPrice(D1, vehicle.vin, pending.at, price, cost);
      } catch (err) { console.warn("[fuel] 回写加油记录失败:", err?.message); }
    }
  }
  await db.setState(D1, "fuel:pending_price", { ...pending, at: null, price, recorded_at: shanghaiNow() });

  if (pending.message_id) {
    try {
      const vehicle = await db.getVehicle(D1);
      const icons = await db.getState(D1, "card:icons", null);
      const card = cards.buildFuelCard({
        event: {
          started_at: pending.started_at, ended_at: pending.ended_at,
          from: pending.from, to: pending.to, liters,
        },
        priceCny: price,
        lastPriceCny: pending.last_price ?? null,
        rangeFuel: pending.range_fuel ?? null,
        done: true, vehicle, icons,
      });
      const upd = await updateCard(env, pending.message_id, card);
      if (!upd.ok) console.warn("[fuel] 更新原卡失败:", upd.code, upd.msg);
      return { ok: true, msg: `已记录 ¥${price}/L`, price, cost };
    } catch (err) {
      console.error("[fuel] 更新原卡异常:", err?.message);
    }
  }
  return { ok: true, msg: `已记录 ¥${price}/L`, price, cost };
}

/** 文字回复数字录油价（兼容旧用法，返回 true 表示已消费这条消息） */
export async function recordFuelPriceFromText(env, openId, text) {
  const pending = await db.getState(env.DB, "fuel:pending_price");
  if (!pending || !pending.at) return false;
  const cleaned = String(text).replace(/[¥￥\s]/g, "").replace(/(元|块)[\/／]?(升|l|L)?$/, "");
  const m = cleaned.match(/^(\d+(?:\.\d{1,2})?)$/);
  if (!m) return false;
  const price = Number(m[1]);
  if (!(price >= 4 && price <= 20)) return false;
  const r = await finishFuelPrice(env, price);
  if (!r.ok) {
    await sendText(env, { type: "open_id", id: openId }, `没记上：${r.msg}`);
  }
  return true;
}

/** 兼容旧调用：同步跑完再回 toast（webhook 已改用 plan/run 拆分） */
export async function handleCardAction(env, body) {
  const plan = await planCardAction(env, body);
  if (!plan.run) return { toast: plan.toast };
  const r = await runCardAction(env, plan);
  return {
    toast: {
      type: r.ok === false ? "error" : "success",
      content: r.ok === false ? `执行失败：${r.msg || "未知错误"}` : "已发送",
    },
  };
}

export const __test = { partialDay, partialDayCard, maintainText, billsSummary, whereText };
