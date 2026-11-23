import { createVehicleClient } from "./vehicle/index.js";
/**
 * 采集编排（每分钟 Cron）
 *
 * 职责：
 *   1. 拉 VSS 实时信号 → 落 signal_sample
 *   2. 充电状态变化检测 → 充电开始 / 结束 → 飞书推送
 *   3. 行程检测（路线乙：总里程增量）→ 行程小结 → 飞书推送
 *   4. 每天一次：拉 travel/daily/aggregate 单日 → 落 daily_stat → 飞书推日报
 *   5. 每天一次：同步充电会话
 *   6. 采集健康记录
 *
 *  关键约束（D-048）：**日常运行不调用 saos_vehicle**。
 *   车辆信息一次性缓存；否则会与用户手机上的理想 App 抢主 App 登录位。
 */

import { F, pick, num as Fnum, isCharging, isPlugged, chargeStatusText, travelStatusText } from "./fields.js";
import * as db from "./db.js";
import * as cards from "./cards.js";
import { buildDetail } from "./fields.js";
import { parseParkFilekey, signedUrls as parkSignedUrls, downloadImage, PARK_ANGLES } from "./parkphoto.js";
import { isPushOn } from "./pushswitch.js";
import { runReminders } from "./reminders.js";
import { sendCard, sendText, discoverChat, uploadImage } from "./feishu.js";
import { regeo } from "./amap.js";
import { wgs2gcj, haversineM, smoothPath } from "./geo.js";
import { aggregate as energyAggregate, deltaPct } from "./energy.js";
import { signTripToken } from "./tripShare.js";
import { screenshotPage, hasBrowser, SHOT_MIN_KM, SHOT_DAILY_CAP } from "./shot.js";
import { dueTasks, lastWeekRange, lastMonthRange, monthRangeOf, monthBefore, isoWeekKey, eventKeys } from "./schedule.mjs";
import {
  shanghaiNow, shanghaiDate, shanghaiMonth, parseShanghai, fromMillis,
  round, num, haversine, safeJson, shanghaiDiffMs,
} from "./util.js";

const CHARGE_TYPES = [1, 2, 3, 4];
/** 纯日期加减（"YYYY-MM-DD"，按 UTC 算，避免本地时区坑；D-091 用于取上周区间） */
function addDays(dateStr, n) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const TRIP_MIN_KM = 0.5;          // 行程最小里程（低于此视为噪声）
const TRIP_IDLE_MIN = 6;          // 里程停滞多久算行程结束
const TRIP_SETTLE_MIN = 25;       //  D-089：行程结束后等车机累计里程「追上」的最长等待
const DEFAULT_L_PER_100KM = 7.5;  //  D-089：增程器百公里油耗兜底（有历史数据后用实测值）

/** VSS path（实测：L 系整车 152 条里，L6 可用 151 条） */
//  实测可用的 151 条 path（L6 返回 151/152）。
//   唯一缺失的是模板占位符 Vehicle.{{AccountId}}.CarSettings.Preference.CLTCWLTC ——
//   **无效 path 会让整批 400 → 二分拆分 → 子请求爆炸**，故这里固化实测可用集合。
import { VSS_PATHS } from "./vss-paths.js";

function firstValue(vss, candidates) {
  for (const p of candidates) {
    if (vss[p] && vss[p].value !== undefined && vss[p].value !== null) {
      const v = vss[p].value;
      if (typeof v === "object" && v !== null) return v;
      return v;
    }
  }
  return null;
}

function numOf(vss, paths) {
  for (const p of paths) {
    const it = vss[p];
    if (it && it.value !== null && it.value !== undefined && it.value !== "") {
      const n = Number(it.value);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

/** 车机行程表 → 关键里程（米→km） */
export function parseTripTotal(vss) {
  const raw = firstValue(vss, ["Vehicle.Carcenter.Trip.Total"]);
  let obj = raw;
  if (typeof raw === "string") obj = safeJson(raw, null);
  if (!obj || typeof obj !== "object") return null;
  const m = (v) => (v === null || v === undefined ? null : Number(v) / 1000);
  return {
    mileage_km: m(obj.mileage),
    cd_km: m(obj.cdMileage),
    engine_km: m(obj.engineMileage),
    ad_km: m(obj.adMileage),
    noa_km: m(obj.noaMileage),
    lcc_km: m(obj.lccMileage),
    acc_km: m(obj.accMileage),
    ad_days: obj.adMileageDate ?? null,
    city_noa_days: obj.cityNoaDays ?? null,
    city_noa_km: m(obj.cityNoaMileage),
    hwy_noa_days: obj.highWayNoaDays ?? null,
    hwy_noa_km: m(obj.highWayNoaMileage),
    raw: obj,
  };
}

export async function buildClient(env, D1 = null) {
  //  一句话：把「怎么拿到数据」交给 vehicle provider（示例实现见 app/src/lib/vehicle/）。
  //  公开版只带 sample 实现；接你自己的车时实现 vehicle/custom.js。
  return createVehicleClient(env, D1);
}


/** 把日记录聚合成汇总对象（导出以便预览端点复用） */
export function summarizeRows(rows) {
  const s = { travel_km: 0, elec_km: 0, hybrid_km: 0, elec_kwh: 0, fuel_l: 0,
    cost_cny: 0, fuel_cost_cny: 0, charge_kwh: 0, charge_times: 0, ad_km: 0 };
  let active = 0;
  for (const d of rows || []) {
    const km = num(d.travel_km);
    if (km > 0) active += 1;
    s.travel_km += km; s.elec_km += num(d.elec_km); s.hybrid_km += num(d.hybrid_km);
    s.elec_kwh += num(d.elec_kwh); s.fuel_l += num(d.fuel_l);
    s.cost_cny += num(d.cost_cny); s.fuel_cost_cny += num(d.fuel_cost_cny);
    s.charge_kwh += num(d.charge_kwh); s.charge_times += num(d.charge_times);
    s.ad_km += num(d.ad_km);
  }
  for (const k of Object.keys(s)) s[k] = round(s[k], 2);
  s.total_cost = round(s.cost_cny + s.fuel_cost_cny, 2);
  s.pure_ratio = s.travel_km > 0 ? (s.elec_km / s.travel_km) * 100 : 0;
  s.active_days = active;
  s.daily_avg_km = active > 0 ? round(s.travel_km / active, 1) : 0;
  return s;
}

/** 区间内的高亮点 */
export function highlightsRows(rows) {
  const moved = (rows || []).filter((r) => num(r.travel_km) > 0);
  if (!moved.length) return [];
  const out = [];
  const best = moved.slice().sort((a, b) =>
    (num(a.elec_km) / Math.max(1, num(a.travel_km))) - (num(b.elec_km) / Math.max(1, num(b.travel_km))))[0];
  out.push({ label: `最${num(best.elec_km) / Math.max(1, num(best.travel_km)) >= 0.6 ? "省" : "费油"}的一天`,
    value: `${best.stat_date} · 纯电占比 ${(num(best.elec_km) / Math.max(1, num(best.travel_km)) * 100).toFixed(0)}% · ${num(best.travel_km).toFixed(1)} km` });
  const far = moved.slice().sort((a, b) => num(b.travel_km) - num(a.travel_km))[0];
  out.push({ label: "最远的一天", value: `${far.stat_date} · ${num(far.travel_km).toFixed(1)} km` });
  const cheap = moved.slice().sort((a, b) => num(a.elec_kwh) / Math.max(1, num(a.travel_km)) - num(b.elec_kwh) / Math.max(1, num(b.travel_km)))[0];
  out.push({ label: "最省电的一天", value: `${cheap.stat_date} · ${(num(cheap.elec_kwh) / Math.max(1, num(cheap.travel_km)) * 100).toFixed(1)} kWh/100km` });
  return out;
}

/** 主采集流程 */
/**
 * 凭据健康检查（面板「凭据」徽标 / 凭据告警卡的数据源）。
 *
 *  公开版不碰任何登录协议，所以这里只做一件事：问 provider「现在什么状态」。
 *  示例实现恒返回 level="sample"（不告警）；接自己的车时由你的 provider 返回
 *  ok / warning / critical / dead（干的活和原来一样：落 state + 落健康表 + 临期告警）。
 */
export async function checkCredentialHealth(env, D1, vin, results, log, client = null) {
  const c = client || (await buildClient(env, D1));
  const status = c?.credentialStatus?.() || { level: "unknown", warnings: [] };
  results.credentials = {
    level: status.level,
    days_left: status.days_left ?? null,
    expires_at: status.expires_at ?? null,
    expiry_source: status.expiry_source ?? null,
  };
  await db.setState(D1, "creds:status", status);
  await db.healthUpsert(
    D1, vin, "creds",
    status.level !== "dead",
    (status.warnings || []).join("; ") || null,
  );
  if (status.level === "ok" || status.level === "sample") return status;

  const target = await db.getState(D1, "feishu:target");
  if (!target) {
    log("凭据有问题，但还没绑定飞书推送目标，跳过告警");
    return status;
  }
  const eventKey = `cred:alert:${status.level}:${shanghaiDate()}`;
  const first = await db.markPushed(D1, vin, eventKey, "feishu", { level: status.level });
  if (!first) return status;

  const card = cards.buildCredCard({
    level: status.level,
    daysLeft: status.days_left ?? null,
    expiresText: status.expires_at ?? null,
    items: status.items || [],
  });
  const res = await sendCard(env, target, card);
  if (res.ok) results.pushed.push({ key: eventKey, ok: true });
  else results.errors.push(`cred-alert: ${res.msg}`);
  return status;
}

/**
 * D-200：采集加一把 D1 重入锁（cron 一分钟一次，慢一轮就会与下一轮重叠）。
 *  锁有效期 150 s：超过就认为上一轮已死，允许重入。
 */
export async function collect(env, ctx = {}) {
  const D1 = env.DB;
  const LOCK = "collect:lock";
  let locked = false;
  try {
    const lock = await db.getState(D1, LOCK, null);
    if (lock && Date.now() - Number(lock.at_ms || 0) < 150000) {
      return {
        steps: [{ skipped: true, reason: "already-running" }],
        pushed: [],
        errors: [],
        skipped: true,
        poll: lock.poll || null,
      };
    }
    await db.setState(D1, LOCK, { at_ms: Date.now(), source: ctx.source || "" });
    locked = true;
  } catch { /* 锁读写失败绝不挡住主链路 */ }
  try {
    return await collectInner(env, ctx);
  } finally {
    if (locked) {
      try { await db.setState(D1, LOCK, { at_ms: 0 }); } catch { /* ignore */ }
    }
  }
}

async function collectInner(env, ctx = {}) {
  const log = ctx.log || console.log;
  const results = { steps: [], pushed: [], errors: [] };
  const D1 = env.DB;
  const client = await buildClient(env, D1);

  //  还没绑定推送目标 → 尝试自动发现（机器人被拉进任意群即可）
  if (!(await db.getState(D1, "feishu:target"))) {
    try {
      const found = await discoverChat(env);
      if (found && found.id) {
        await db.setState(D1, "feishu:target", { ...found, at: shanghaiNow() });
        log("自动发现推送目标:", found.id, found.name || "");
      }
    } catch { /* ignore */ }
  }

  //  scope token 持久化到 D1 —— Workers 每次 cron 都是全新 isolate，
  //   内存缓存无效。若不持久化，每分钟都会打一次 SSO /api/auth
  //   → 实测高频后开始返回 400 Bad Request。
  //   scope token 有效期约 780s（13 分钟）→ 每 13 分钟才换一次。
  client.scopeProvider = async (scope, audience) => {
    const key = `scope:${scope}|${audience}`;
    const st = await db.getState(D1, key);
    if (st?.token && Number(st.exp) > Date.now()) return st.token;
    const token = await client.exchangeScope(scope, audience);
    await db.setState(D1, key, { token, exp: Date.now() + 700 * 1000 });
    return token;
  };

  //  D-048（实测）：车辆信息【一次性】获取后永久缓存，运行期【禁止】调用 saos_vehicle。
  //    原因：saos_vehicle 的 audience 白名单只认主 App client → 需回退主 App client 参数
  //    → 会与用户手机上的理想 App 抢登录位（实测手机重登后该接口即 login_required）。
  //    若运行期调用，会：① 与手机抢登录位 ② 主 App client 参数的 /api/auth 在
  //    Node/Workers 的 fetch 栈上返回 400（Python requests 返回 300，客户端栈差异）。
  const vehicle = await db.getVehicle(D1);
  if (vehicle) {
    client.vin = vehicle.vin;
  } else {
    results.errors.push("车辆信息未初始化（请运行 scripts/seed-vehicle.mjs 从本地缓存注入）");
    await db.healthUpsert(D1, client.vin || "unknown", "vehicles", false, "未初始化");
    return results;
  }
  const vin = client.vin;

  // ── 0. 自适应轮询闸门（D-093）──
  //   Cron 仍每分钟触发（Cloudflare 请求数不变），但没到点就直接返回，
  //   省的是【理想侧调用】与【D1 写入】—— 按真实 3 天数据模拟可省 54%。
  try {
    const plan0 = await db.getState(D1, "poll:plan", null);
    if (plan0 && Number(plan0.next_at_ms) > Date.now()) {
      results.skipped = true;
      results.poll = { mode: plan0.mode, interval_sec: plan0.interval_sec, next_at_ms: plan0.next_at_ms };
      results.steps.push({ skipped: true, mode: plan0.mode, interval_sec: plan0.interval_sec });
      return results;
    }
  } catch { /* 读失败就正常采集，绝不因为轮询逻辑挡住链路 */ }

  // ── 1. VSS ──
  let vss = {};
  let sample = null;
  let prevSample = null;
  try {
    //  子请求预算：Workers 免费版单次调用上限 50 个子请求。
    //   VSS 一次 = 1 次 scope 换取 + ceil(151/50)=4 批 → 约 5 个，够用。
    //   但若某批 400 会二分拆分 → 指数增长 → 必须有硬上限。
    vss = await client.getVss(VSS_PATHS, { maxSubrequests: 20 });
    const trip = parseTripTotal(vss);
    sample = {
      vin,
      sampled_at: shanghaiNow(),
      battery: Fnum(pick(vss, F.soc)),
      range_km: Fnum(pick(vss, F.range_cltc_elec)),
      odometer_km: trip?.mileage_km ?? null,
      speed: Fnum(pick(vss, F.speed)),
      indoor_temp: Fnum(pick(vss, F.indoor_temp)),
      outdoor_temp: null,          // 该车 VSS 不上报车外温度
      charging: isCharging(vss) ? 1 : 0,
      charge_status: chargeStatusText(pick(vss, F.charge_status)),
      travel_status: numOf(vss, ["Vehicle.Cabin.TravelStatus"]),
      //  D-068：加油检测要这两条（油量整数百分比 + 燃油续航）
      fuel_level: Fnum(pick(vss, F.fuel_level)),
      range_fuel: Fnum(pick(vss, F.range_cltc_fuel)),
      trip_total_json: trip ? JSON.stringify(trip.raw) : null,
      //  D-093：payload 原本是整包 151 条 VSS（26.5 KB/行 → 298 MB / 1.1 万行）。
      //   只有「最新一帧」的 detail 有用，所以改存 runtime_state 的 last:detail（~1 KB）。
      payload: null,
    };
    //  D-077：上一帧采样必须在 saveSample **之前**取。
    //    以前 handleTrip 里现取 `db.lastSample()`，而它排到 saveSample 之后，
    //    拿到的其实是「刚写入的当前帧」→ `delta = odo - odo = 0` → 行程永远开不起来，
    //    线上表现就是「离家/到家都有卡，但从来没有行程小结卡」。
    prevSample = await db.lastSample(D1, vin);
    await db.saveSample(D1, sample);
    await db.healthUpsert(D1, vin, "vss", true, null);
    try {
      await db.setState(D1, "last:detail", buildDetail(vss));
    } catch { /* detail 只是展示用，失败不影响采集 */ }
    results.steps.push({ vss: Object.keys(vss).length, trip });

    // 位置（ D-060 修正）：真正有值的是 `CurrentLocationInfo`，字段是 `lat/lon`。
    //   旧代码读 `Vehicle.Location.GpsPosition` 且取 `o.latitude/o.longitude`
    //   → 双重不匹配 → position_sample 一行都没有 → 地理围栏没有数据源。
    //    实测（2026-11-03）：`CurrentLocationInfo.value` 是一个 **JSON 字符串**
    //   （`"{\"alt\":21.58,\"lat\":30.000000,…}"`），不是对象 —— 必须先 JSON.parse，
    //   否则 typeof 是 string → 被当成「无值」丢弃。这是 D-060 没发现的第二层坑。
    let loc = firstValue(vss, ["Vehicle.Location.CurrentLocationInfo"])
      || firstValue(vss, ["Vehicle.Location.GpsPosition"]);
    if (typeof loc === "string") {
      try { loc = JSON.parse(loc); } catch { loc = null; }
    }
    const o = (loc && typeof loc === "object") ? loc : null;
    const fnum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    const lat = o ? fnum(o.lat ?? o.latitude) : null;
    const lon = o ? fnum(o.lon ?? o.longitude) : null;
    if (lat !== null && lon !== null && (lat !== 0 || lon !== 0)) {
      await db.savePosition(D1, {
        vin, sampled_at: sample.sampled_at,
        lat, lon,
        altitude: o ? fnum(o.alt ?? o.altitude) : null,
        direction: o ? fnum(o.dir ?? o.direction) : null,
      });
      results.steps.push({ position: { lat: Number(lat.toFixed(4)), lon: Number(lon.toFixed(4)) } });
      //  D-069：把位置挂到 sample 上，后面行程卡（起止位置）与围栏判定都要用
      sample.position = { lat, lon };
    }

    // ── 2. 充电状态变化 ──
    await handleChargeTransition(env, D1, client, vehicle, sample, vss, results, log);

    // ── 3. 行程检测 ──
    await handleTrip(env, D1, client, vehicle, sample, trip, results, log, prevSample);

    // ── 3.1 加油检测（D-068）──
    await handleFuelTransition(env, D1, vehicle, sample, results, log);

    // ── 3.2 地理围栏（到时/离家提醒，D-069）──
    await flushPendingStop(env, D1, vehicle, results, log);
    await handleGeofence(env, D1, vehicle, sample, results, log);

    // ── 3.2b 泊车照片（车机停车后自动拍的 5 张，D-093）──
    try {
      await handleParkPhoto(env, D1, client, vehicle, sample, vss, results, log);
    } catch (err) {
      results.errors.push(`park: ${err.message}`);
    }

    // ── 3.3 异常自检（胎压/低电量/低油/插枪未充电，D-071）──
    await handleAnomalies(env, D1, vehicle, sample, vss, results, log);
    await handleEnergyLow(env, D1, vehicle, sample, results, log);

    // ── 3.4 主动提醒（保养/OTA/停车掉电/充电故障，D-088）──
    try {
      const reminders = await runReminders(D1, vin, sample, vss);
      results.reminders = reminders.map((r) => r.kind);
      for (const r of reminders) {
        const target = await pushTarget(D1, r.kind);
        if (!target) { log(`提醒 ${r.kind} 已关闭，跳过推送`); continue; }
        if (!(await db.markPushed(D1, vin, r.dedupeKey, "feishu", r.card))) { log(`提醒 ${r.kind} 今日已推过`); continue; }
        const sent = await sendCard(env, target, r.card);
        if (sent?.code === 0) { results.pushed.push({ key: r.dedupeKey, ok: true }); log(`提醒已推送: ${r.kind}`); }
        else { results.errors.push(`reminder ${r.kind}: ${JSON.stringify(sent)}`); }
      }
    } catch (err) {
      results.errors.push(`reminders: ${err.message}`);
    }

    // ── 3.5 充电建议（在家 + 电量 ≤30% + 非谷时 → 提示等谷时，D-091/D-174）──
    try {
      await handleChargeAdvice(env, D1, vehicle, sample, results, log);
    } catch (err) {
      results.errors.push(`advice: ${err.message}`);
    }
  } catch (err) {
    results.errors.push(`vss: ${err.message}`);
    await db.healthUpsert(D1, vin, "vss", false, err.message);
  }

  // ── 3.6 充电会话补齐 + 完成卡补发（D-064）──
  //   理想侧 chargeRecords/monthly 常在充电结束【之后】才写入那一行，
  //   结束瞬间查不到 → 卡片全是 "--"。这里每轮回看补齐并补发一次。
  try {
    await reconcileChargeSessions(env, D1, client, vin, results, log);
    await pushMissingChargeReceipts(env, D1, client, vin, results, log);
  } catch (err) {
    results.errors.push(`charge-reconcile: ${err.message}`);
  }

  // ── 3.7 凭据健康检查 + 临期告警（D-065）──
  //   命门 cookie `sso_token` 只有 13 天且【没有】免密续期通道，
  //   过期后换不到 scope token → VSS 采集全挂 → 日报静默停发（不报错）。
  //   这里每轮检查，临期推一张红色告警卡（每个级别每天最多一次）。
  try {
    await checkCredentialHealth(env, D1, vin, results, log);
  } catch (err) {
    results.errors.push(`creds: ${err.message}`);
  }

  // ── 4. 每日任务 + 定时推送 ──
  try {
    await dailyTask(env, D1, client, vehicle, results, log);
  } catch (err) {
    results.errors.push(`daily: ${err.message}`);
    await db.healthUpsert(D1, vin, "daily", false, err.message);
  }

  try {
    await scheduledPush(env, D1, vehicle, results, log);
  } catch (err) {
    results.errors.push(`scheduled: ${err.message}`);
  }

  // ── 5. 计算下一次采集时间（自适应轮询，D-093）──
  try {
    if (sample) results.poll = await nextPollPlan(D1, vin, sample, prevSample);
  } catch (err) {
    results.errors.push(`poll: ${err.message}`);
  }

  return results;
}

/** 定时推送：每日小结 / 周报 / 月报（幂等，重复触发不会重发） */
async function scheduledPush(env, D1, vehicle, results, log) {
  const vin = vehicle.vin;
  const now = new Date();
  const due = dueTasks(now);
  const target = await db.getState(D1, "feishu:target");
  if (!target) return;                       // 没绑定目标就不推
  const price = await db.currentPrice(D1);
  const fuelPrice = await db.currentFuelPrice(D1);

  // ── 每日小结（昨日）──
  if (due.daily) {
    const y = shanghaiDate(new Date(now.getTime() - 24 * 3600 * 1000));
    const row = await db.getDaily(D1, vin, y);
    if (row) {
      const key = eventKeys.daily(vin, y);
      if (await db.markPushed(D1, vin, key, "feishu", { km: row.travel_km })) {
        const res = await sendCard(env, target, cards.buildDailyCard({
          d: row, priceCny: price, fuelPriceCny: fuelPrice, dateLabel: y,
        }));
        results.pushed.push({ key, ok: res.ok });
        log("日报推送 →", y, res.ok ? "已发送" : `失败 ${res.msg || ""}`);
      }
    }
  }

  // ── 周报（上周）──
  if (due.weekly) {
    const { from, to } = lastWeekRange(now);
    const rows = await db.listDaily(D1, vin, from, to);
    if (rows.length) {
      const weekKey = isoWeekKey(new Date(now.getTime() - 24 * 3600 * 1000));
      const key = eventKeys.weekly(vin, weekKey);
      if (await db.markPushed(D1, vin, key, "feishu", { from, to })) {
        const prevRows = await db.listDaily(D1, vin, addDays(from, -7), addDays(from, -1));
        const up = await usagePrice(D1, vin, `${to} 23:59:59`);
        const res = await sendCard(env, target, cards.buildWeeklyCard({
          summary: summarizeRows(rows), days: rows,
          weekLabel: `${from} ~ ${to}`, highlights: highlightsRows(rows),
          energy: energyAggregate(rows), prev: energyAggregate(prevRows),
          vehicle, priceCny: up.price, icons: await db.getState(D1, "card:icons", null),
        }));
        results.pushed.push({ key, ok: res.ok });
        log("周报推送 →", from, to, res.ok ? "已发送" : `失败 ${res.msg || ""}`);
      }
    }
  }

  // ── 月报（上月）──
  if (due.monthly) {
    const { from, to, month } = lastMonthRange(now);
    const rows = await db.listDaily(D1, vin, from, to);
    if (rows.length) {
      const key = eventKeys.monthly(vin, month);
      if (await db.markPushed(D1, vin, key, "feishu", { month })) {
        const fuel = await fuelSummary(D1, vin, from, to);
        const pmRange = monthRangeOf(monthBefore(month));
        const pmRows = await db.listDaily(D1, vin, pmRange.from, pmRange.to);
        const upM = await usagePrice(D1, vin, `${to} 23:59:59`);
        const res = await sendCard(env, target, cards.buildMonthlyCard({
          summary: summarizeRows(rows), days: rows,
          monthLabel: month, highlights: highlightsRows(rows), fuel,
          vehicle, priceCny: upM.price, icons: await db.getState(D1, "card:icons", null),
          prev: summarizeRows(pmRows), title: "上月用车小结",
        }));
        results.pushed.push({ key, ok: res.ok });
        log("月报推送 →", month, res.ok ? "已发送" : `失败 ${res.msg || ""}`);
      }
    }
  }
}

/** 充电开始 / 结束检测（实时状态 + 会话补齐，见 D-046） */
/** 充完电「续航增加多少 km」：Δ电量% × 当前每 1% 能跑多少（两者都来自车机上报，不估算）。 */
function addedKmOf(prev, sample, vss) {
  const b0 = Number(prev?.battery);
  const b1 = Number(sample?.battery != null ? sample.battery : vss?.battery);
  const range = Number(vss?.range_elec);
  if (!(b0 > 0) || !(b1 > b0) || !(range > 0)) return null;
  return Math.round(((b1 - b0) * range) / b1);
}

async function handleChargeTransition(env, D1, client, vehicle, sample, vss, results, log) {
  const vin = vehicle.vin;
  const now = sample.sampled_at;
  const prev = await db.getState(D1, `charge:${vin}`);
  const charging = sample.charging === 1;
  //  D-064：target 必须在【函数作用域】取一次。
  //   之前只在 charge-start 分支的块内 `const target = ...`，
  //   charge-end 分支引用的是未定义变量 → ReferenceError: target is not defined
  //   → 结束卡片永远发不出去，且异常冒泡到 collect() 的 try 块
  //   → 同一轮的 handleTrip 也被一起跳过。
  const target = await pushTarget(D1, "charge");

  if (charging && (!prev || !prev.charging)) {
    // 充电开始
    const key = `charge:start:${now.slice(0, 16)}`;
    if (await db.markPushed(D1, vin, key, "feishu", { at: now })) {
      //  D-068：分时段电价
      const price = await db.elecTierPriceAt(D1, now);
      const card = cards.buildChargeCard({
        session: { started_at: now, charging_type: null, capacity_kwh: null },
        priceCny: price,
        phase: "start",
        vehicle,
        battery: sample.battery != null ? sample.battery : vss?.battery,
        range: vss?.range_elec,
        icons: await db.getState(D1, "card:icons", null),
      });
      const res = target ? await sendCard(env, target, card) : { ok: false, msg: "未绑定飞书目标" };
      results.pushed.push({ key, ok: res.ok });
      log("充电开始 →", res.ok ? "已推送" : `推送失败 ${res.raw || ""}`);
    }
    // 记下开始时的电量，结束卡要算「续航增加」（D-137）
    await db.setState(D1, `charge:${vin}`, {
      charging: true, started_at: now,
      battery: sample.battery != null ? sample.battery : vss?.battery ?? null,
    });
  } else if (!charging && prev?.charging) {
    // 充电结束：结算本次会话
    const started = prev.started_at || now;
    const durMin = Math.max(1, Math.round((parseShanghai(now) - parseShanghai(started)) / 60000));
    const sessionKey = `${started}|${prev.charging_type ?? ""}`;
    const rows = await fetchChargeSessions(client, vin);
    //  D-064：匹配充电会话。
    //    不要写 `new Date(fromMillis(r.startTime))` —— fromMillis 返回不带
    //   时区的 "YYYY-MM-DD HH:MM:SS"，JS 按【本地时区】解析。Workers 本地
    //   时区是 UTC（vars.TZ 不影响运行时）→ 偏差 8 小时 → 窗口匹配永远失效。
    //   这里统一用 shanghaiDiffMs（内部走 parseShanghai，零时区歧义）。
    const hit = rows.find((r) => fromMillis(r.startTime) === started)
      || rows.find((r) => {
        const d = shanghaiDiffMs(fromMillis(r.startTime), started);
        return d !== null && d < 5 * 60_000;
      });
    const capacity = hit ? num(hit.chargingCapacity) : null;
    //  D-068：跨时段充电按【分钟数加权平均单价】（功率恒定假设，标「约」）
    const pw = await db.elecPriceWindow(D1, started, now);
    const price = pw.avg;
    const cost = capacity !== null && price !== null ? round(capacity * price, 2) : null;
    await db.upsertChargeSession(D1, {
      vin, session_key: sessionKey, started_at: started, ended_at: now,
      duration_min: durMin, capacity_kwh: capacity,
      charging_type: hit ? hit.chargingType : null,
      avg_power_kw: capacity && durMin ? round((capacity * 60) / durMin, 1) : null,
      cost_cny: cost, price_per_kwh: price,
    });
    //  D-078：结算完立刻刷新「用车电价」基准（后续日报/行程卡都用它）
    await refreshUsagePrice(D1, vin, {
      session_key: sessionKey, started_at: started, ended_at: now,
      capacity_kwh: capacity, price_per_kwh: price,
    });
    //  D-078：去重 —— 每天一次的 charge_sync 会按 millis 键再建一行（无 ended_at），
    //   同一次充电被记两遍 → 日报电费翻倍。实时结算拿到真行后把那条删掉。
    if (hit) {
      const syncKey = `${hit.startTime}|${hit.chargingType}`;
      if (syncKey !== sessionKey) await db.deleteChargeSession(D1, vin, syncKey);
    }
    const key = `charge:end:${sessionKey}`;
    //  D-064：先把状态落库，再推卡片。
    //   旧顺序是「markPushed → 推卡片 → setState(charging:false)」，
    //   一旦推卡片抛错，setState 不执行 → charge state 永远停在 charging:true
    //   → 结束事件永远不会被再次消费（且幂等键已被 burn 掉）。
    //   现在先 setState → 状态不再卡死；推送失败也不影响状态收敛。
    await db.setState(D1, `charge:${vin}`, { charging: false, started_at: null });
    //  D-089：理想侧电量常滞后上报。没有「充入电量」时【不推空卡】
    //   （用户 2026-11-05 报障：先收到一张全是 -- 的完成小票，几分钟后又收到完整的一张）。
    //   有电量 → 推完整卡，并把「补发」幂等键一并占掉，防止 reconcile 再推一次；
    //   没电量 → 只记 pending，等补齐后由 pushMissingChargeReceipts 推一张完整卡。
    if (capacity !== null && await db.markPushed(D1, vin, key, "feishu", { started_at: started, capacity })) {
      await db.markPushed(D1, vin, `${key}|filled`, "feishu", { suppressed: "pushed_at_end" });
      const res = target ? await sendCard(env, target, cards.buildChargeCard({
        session: {
          started_at: started, ended_at: now, duration_min: durMin,
          capacity_kwh: capacity, charging_type: hit?.chargingType ?? null,
          avg_power_kw: capacity && durMin ? round((capacity * 60) / durMin, 1) : null,
          cost_cny: cost,
          price_per_kwh: price,
        },
        priceCny: price,
        vehicle,
        battery: sample.battery != null ? sample.battery : vss?.battery,
        addedKm: addedKmOf(prev, sample, vss),
        icons: await db.getState(D1, "card:icons", null),
      })) : { ok: false, msg: "未绑定飞书目标" };
      results.pushed.push({ key, ok: res.ok });
      log("充电结束 →", res.ok ? "已推送" : `推送失败 ${res.raw || ""}`);
    } else if (capacity === null) {
      // 电量还没上报：不推卡，记一笔待补（>6 小时仍无数据 → 推一张说明卡）
      await db.setState(D1, `charge:pending:${sessionKey}`, { started_at: started, at: now });
      log("充电结束但电量未上报 → 暂不推卡，等补齐");
    }
  } else if (charging) {
    await db.setState(D1, `charge:${vin}`, { ...prev, charging: true });
  }
}

/**
 *  D-064：补齐「刚结束但电量还没可见」的充电会话。
 *
 * 现象（2026-11-02 实测）：充电 11:34 开始、12:05 结束，
 * 但结束那一刻理想侧 chargeRecords/monthly 还没把这一行写进去
 * → charge-end 分支拿不到 chargingCapacity → 卡片全是 "--"。
 * 事后几十分钟再查，同一条记录就有了（24.21 kWh / type 1）。
 *
 * 这里做一次「回看补齐」：把 D1 里最近 24 小时内、capacity 仍为 null 的
 * 充电会话重新去理想侧匹配一次，拿到电量就补写进 D1。
 *  只写数据库，不发卡片（避免刷屏）；卡片由下面的补偿推送负责。
 */
async function reconcileChargeSessions(env, D1, client, vin, results, log) {
  try {
    const pending = await db.listChargeSessions(D1, vin, 50);
    const stale = (pending || []).filter((s) =>
      s.capacity_kwh === null || s.capacity_kwh === undefined
    );
    if (!stale.length) return;

    const rows = await fetchChargeSessions(client, vin);
    if (!rows.length) return;

    let filled = 0;
    for (const s of stale) {
      const started = s.started_at;
      if (!started) continue;
      const hit = rows.find((r) => fromMillis(r.startTime) === started)
        || rows.find((r) => {
          const d = shanghaiDiffMs(fromMillis(r.startTime), started);
          return d !== null && d < 5 * 60_000;
        });
      if (!hit) continue;
      const capacity = num(hit.chargingCapacity, null);
      if (capacity === null) continue;
      //  D-068：按该会话实际起止时间取时段加权电价
      const pw = await db.elecPriceWindow(D1, s.started_at, s.ended_at || s.started_at);
      const price = pw.avg;
      const durMin = num(s.duration_min, null);
      await db.upsertChargeSession(D1, {
        vin, session_key: s.session_key,
        started_at: s.started_at,
        ended_at: s.ended_at,
        duration_min: durMin,
        capacity_kwh: capacity,
        charging_type: hit.chargingType ?? s.charging_type,
        avg_power_kw: durMin ? round((capacity * 60) / durMin, 1) : s.avg_power_kw,
        cost_cny: price !== null ? round(capacity * price, 2) : s.cost_cny,
        price_per_kwh: price ?? s.price_per_kwh,
      });
      filled += 1;
    }
    if (filled) {
      log(`充电会话补齐 ${filled} 条（理想侧记录延迟可见）`);
      results.chargeReconciled = (results.chargeReconciled || 0) + filled;
      //  D-078：补齐后才有真实电量/电价 → 用它刷新「用车电价」基准
      const latest = await db.lastChargePrice(D1, vin, null);
      if (latest) {
        await refreshUsagePrice(D1, vin, {
          session_key: latest.session_key, started_at: latest.started_at,
          ended_at: latest.ended_at, capacity_kwh: latest.capacity_kwh,
          price_per_kwh: latest.price_per_kwh,
        });
      }
    }
  } catch (err) {
    // 补齐失败不影响主流程
    log("充电会话补齐失败:", err.message);
  }
}

/**
 *  D-064：给「已经结束但当时没推出去」的会话补发完成卡片。
 *
 * 场景：结束那一刻因为理想侧记录还没可见，卡片里的电量是 "--"；
 * 或推送本身失败。电量补齐后，这里补发一次带真实电量的卡片。
 * 幂等键用 `charge:end:<session_key>|filled` → 每个会话只补发一次。
 */
async function pushMissingChargeReceipts(env, D1, client, vin, results, log) {
  try {
    const target = await pushTarget(D1, "charge");
    if (!target) return;
    const sessions = await db.listChargeSessions(D1, vin, 50);
    const done = (sessions || []).filter((s) =>
      s.capacity_kwh !== null && s.capacity_kwh !== undefined
      && s.ended_at && s.duration_min
    );
    //  D-089：一直拿不到电量的会话（车机/理想侧始终没上报）不能永远静默 ——
    //   超过 6 小时推一张「已结束但电量未上报」的说明卡，只推一次。
    const nowMs2 = Date.now();
    for (const s of sessions || []) {
      if (s.capacity_kwh !== null && s.capacity_kwh !== undefined) continue;
      if (!s.ended_at) continue;
      const age = nowMs2 - (parseShanghai(s.ended_at)?.getTime() || nowMs2);
      if (age < 6 * 3600 * 1000) continue;
      const nk = `charge:end:${s.session_key}|nodata`;
      if (!(await db.markPushed(D1, vin, nk, "feishu", { started_at: s.started_at }))) continue;
      const res = await sendCard(env, target, cards.buildChargeCard({
        session: {
          started_at: s.started_at, ended_at: s.ended_at,
          duration_min: num(s.duration_min, null), capacity_kwh: null,
          charging_type: s.charging_type, avg_power_kw: null, cost_cny: null,
          price_per_kwh: num(s.price_per_kwh, null),
        },
        priceCny: num(s.price_per_kwh, null),
        phase: "end",
        noData: true,
      }));
      results.pushed.push({ key: nk, ok: res.ok });
      log("充电完成卡（无电量兜底）→", s.started_at, res.ok ? "已推送" : `推送失败 ${res.raw || ""}`);
    }
    for (const s of done) {
      const key = `charge:end:${s.session_key}|filled`;
      if (!(await db.markPushed(D1, vin, key, "feishu", {
        started_at: s.started_at, capacity: s.capacity_kwh,
      }))) continue;
      const price = num(s.price_per_kwh, null)
        ?? (await db.elecPriceWindow(D1, s.started_at, s.ended_at || s.started_at)).avg;
      const res = await sendCard(env, target, cards.buildChargeCard({
        session: {
          started_at: s.started_at, ended_at: s.ended_at,
          duration_min: num(s.duration_min, null),
          capacity_kwh: num(s.capacity_kwh, null),
          charging_type: s.charging_type,
          avg_power_kw: num(s.avg_power_kw, null),
          cost_cny: num(s.cost_cny, null),
          price_per_kwh: num(s.price_per_kwh, null),
        },
        priceCny: price,
      }));
      results.pushed.push({ key, ok: res.ok });
      log("充电完成补发 →", s.started_at, res.ok ? "已推送" : `推送失败 ${res.raw || ""}`);
    }
  } catch (err) {
    log("充电完成补发失败:", err.message);
  }
}
async function fetchChargeSessions(client, vin) {
  const dt = shanghaiMonth();
  const out = [];
  for (const ct of CHARGE_TYPES) {
    try {
      const r = await client.getChargeSessions(dt, ct);
      for (const row of r.data || []) out.push({ ...row, chargingType: row.chargingType ?? ct });
    } catch { /* 某类型失败不影响其他 */ }
  }
  return out.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
}

/** 行程检测：总里程增量法（路线乙） */
/** 位置 → 可读地点：落在某个围栏内用围栏名，否则用 2 位小数的粗略坐标（不泄露精确位置） */
/**
 * 地址压到一屏读得完（D-200）：去掉 省 / 市 / 区县 前缀，只留街道往后。
 *  泊车卡折叠行只有一行位置，完整地址会被截断成看不出是哪的半截话。
 */
function compactPlace(addr) {
  const s = String(addr || "").trim();
  if (!s) return "";
  return s
    .replace(/^.+?(省|自治区)/, "")
    .replace(/^.+?(市|自治州|地区)/, "")
    .replace(/^.+?(区|县)(?=.)/, "")
    .trim() || s;
}

function locLabel(pos, geos) {
  if (!pos || pos.lat === null || pos.lat === undefined || pos.lon === null || pos.lon === undefined) return "--";
  for (const g of geos || []) {
    const r = num(g.radius_m, 500) || 500;
    if (haversine(pos.lat, pos.lon, g.lat, g.lon) <= r) return g.label;
  }
  return `${Number(pos.lat).toFixed(2)}, ${Number(pos.lon).toFixed(2)}`;
}

/**
 * 行程小结（D-069 定稿）。
 *   口径（依据 D-059/D-062 实测）：
 *   - 里程 = 车机累积总里程 `mileage` 差分（准确）
 *   - 纯电 = 车机累积纯电里程 `cdMileage` 差分（准确，误差 ~0.1km 级）
 *   - 发动机 = 总里程 − 纯电（**估算**：`engineMileage` 是增程器保养计数，不能差分）
 *   - 智驾 = 累积 `adMileage` 差分
 *   - 起止位置 = 围栏名 或 2 位小数坐标（无逆地理编码服务）
 *
 *    顺带修掉一个真 Bug：旧实现用「odo − start_odo」判断是否还在走，
 *     只要本次行程已跑过 0.5km 就恒为真 → last_change_at 每分钟刷新 →
 *     **行程永远不会结束、卡片永远不推**。现在改为跟 `last_odo` 比。
 */
/**
 * 回溯补行程（D-077）
 *
 * 用途：行程检测曾经因为「取到当前帧当上一帧」的 bug 全程失效（D-077），历史行程没落库、没推卡。
 * 这里从 signal_sample 里按里程增长切出行程窗口，补 `trip_log` + 线路图，可选补推卡片。
 *
 * 切分规则（与实时状态机同口径）：
 *   - 里程相对上一帧增长 > TRIP_MIN_KM(0.5) → 认为在走
 *   - 连续 TRIP_IDLE_MIN(6) 分钟里程不变 → 认为这段行程结束
 *   - 单段里程 > TRIP_MIN_KM 才算一条行程
 */
export async function backfillTrips(env, D1, vin, from, to, opts = {}) {
  const log = opts.log || console.log;
  const push = opts.push === true;
  const rows = await db.listSamplesBetween(D1, vin, from, to);
  const out = { samples: rows.length, trips: [], pushed: [], errors: [] };
  if (rows.length < 3) return out;

  const windows = [];
  let cur = null;
  let prev = rows[0];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const odo = num(r.odometer_km);
    const prevOdo = num(prev.odometer_km);
    if (odo === null || prevOdo === null) { prev = r; continue; }
    const delta = odo - prevOdo;
    if (delta > 0.05) {
      if (!cur) cur = { startIdx: i - 1, lastMoveIdx: i };
      else cur.lastMoveIdx = i;
    } else if (cur) {
      const idleMs = (parseShanghai(r.sampled_at)?.getTime() || 0) - (parseShanghai(rows[cur.lastMoveIdx].sampled_at)?.getTime() || 0);
      if (idleMs > TRIP_IDLE_MIN * 60_000) { cur.endIdx = i; windows.push(cur); cur = null; }
    }
    prev = r;
  }
  if (cur) windows.push(cur);

  for (const w of windows) {
    const a = rows[w.startIdx];
    const b = rows[Math.min(w.lastMoveIdx + 1, rows.length - 1)];
    //  D-089：结束时刻用「停滞判定帧」（与实时路径口径一致），不用最后一个移动点+1
    const endRow = rows[w.endIdx ?? Math.min(w.lastMoveIdx + 1, rows.length - 1)];
    const distance = round(num(b.odometer_km) - num(a.odometer_km), 1);
    if (!(distance > TRIP_MIN_KM)) continue;
    const dur = Math.round(((parseShanghai(endRow.sampled_at)?.getTime() || 0) - (parseShanghai(a.sampled_at)?.getTime() || 0)) / 60000);
    // 纯电/智驾：从车机累积值差分（trip_total_json 存的是 36 字段原始 JSON，单位米）
    const cd = (row) => {
      try { const j = safeJson(row.trip_total_json, null); return j && j.cdMileage !== undefined ? Number(j.cdMileage) / 1000 : null; } catch { return null; }
    };
    const ad = (row) => {
      try { const j = safeJson(row.trip_total_json, null); return j && j.adMileage !== undefined ? Number(j.adMileage) / 1000 : null; } catch { return null; }
    };
    const eng = (row) => {
      try { const j = safeJson(row.trip_total_json, null); return j && j.engineMileage !== undefined ? Number(j.engineMileage) / 1000 : null; } catch { return null; }
    };
    const elec = (cd(a) !== null && cd(b) !== null) ? round(Math.max(0, cd(b) - cd(a)), 1) : null;
    //  D-089：发动机里程用车机增程器里程差分（历史窗口数据已同步，可直接用）
    const engKm = (eng(a) !== null && eng(b) !== null) ? round(Math.max(0, eng(b) - eng(a)), 1) : null;
    let elecFinal = elec;
    let engineFinal = engKm !== null
      ? round(Math.min(engKm, Math.max(0, distance - (elec || 0))), 1)
      : (elec !== null ? round(Math.max(0, distance - elec), 1) : null);
    //  D-089：余量归属（与实时路径同口径）
    if (elecFinal !== null && engineFinal !== null && distance - elecFinal - engineFinal > 0.3) {
      if (engineFinal > 0.1) engineFinal = round(distance - elecFinal, 1);
      else elecFinal = round(distance - engineFinal, 1);
    }
    const adKm = (ad(a) !== null && ad(b) !== null) ? round(Math.max(0, ad(b) - ad(a)), 1) : null;

    //  D-090：实时路径已经写过这一条时，backfill 不得覆盖它的核心数字。
    //   实时路径有「结算等待」（D-089）会把短停并入同一程；backfill 按 6 分钟停滞切段，
    //   同一段路会算出不同结果（实测 19.4km/77min 被改写成 18.5km/48min）。
    //   默认 existing 优先；显式 opts.force=true 才允许覆盖（用于修历史错值）。
    const existing = opts.force ? null : await db.getTripLogByStart(D1, vin, a.sampled_at);

    const geos = await db.listGeofences(D1, vin);
    const positions = await db.listPositionsBetween(D1, vin, a.sampled_at, b.sampled_at);
    const startPos = positions.length ? { lat: positions[0].lat, lon: positions[0].lon } : null;
    const endPos = positions.length ? { lat: positions[positions.length - 1].lat, lon: positions[positions.length - 1].lon } : null;

    const id = await db.saveTripLog(D1, {
      vin, started_at: a.sampled_at,
      ended_at: existing && existing.ended_at && existing.ended_at > endRow.sampled_at ? existing.ended_at : endRow.sampled_at,
      distance_km: existing && existing.distance_km !== null ? existing.distance_km : distance,
      duration_min: existing && existing.duration_min !== null ? Math.max(existing.duration_min, dur) : dur,
      elec_km: existing && existing.elec_km !== null ? existing.elec_km : elecFinal,
      engine_km: existing && existing.engine_km !== null ? existing.engine_km : engineFinal,
      ad_km: existing && existing.ad_km !== null ? existing.ad_km : adKm,
      battery_from: num(a.battery), battery_to: num(b.battery),
      start_loc: locLabel(startPos, geos), end_loc: locLabel(endPos, geos),
      start_lat: startPos?.lat ?? null, start_lon: startPos?.lon ?? null,
      end_lat: endPos?.lat ?? null, end_lon: endPos?.lon ?? null,
      created_at: shanghaiNow(),
    });
    let route = null;
    try {
      route = await buildTripRoute(env, D1, vin, id, a.sampled_at, b.sampled_at, startPos, endPos);
    } catch (err) {
      out.errors.push(`route(${a.sampled_at}): ${err.message}`);
    }
    const item = { id, started_at: a.sampled_at, ended_at: endRow.sampled_at, distance_km: distance, duration_min: dur, elec_km: elecFinal, engine_km: engineFinal, route_km: route?.km ?? null };
    out.trips.push(item);

    if (push) {
      const key = `trip:end:${a.sampled_at}`;
      const target = await pushTarget(D1, "trip");
      if (target && await db.markPushed(D1, vin, key, "feishu", { distance })) {
        //  D-078：补推的卡片也带「本程耗电 / 本程电费」，口径与实时一致
        const up2 = await usagePrice(D1, vin, b.sampled_at);
        const pct2 = (num(b.battery, null) !== null && num(a.battery, null) !== null)
          ? num(b.battery) - num(a.battery) : null;
        const kwh2 = pct2 !== null ? round(Math.abs(pct2) * up2.kwh_per_pct, 2) : null;
        const imageKey = await attachTripImage(env, D1, vin, id, distance, log);
        const res = await sendCard(env, target, cards.buildTripCard({
          imageKey,
          vehicle: await db.getVehicle(D1),
          icons: await db.getState(D1, "card:icons", null),
          trip: {
            id,
            distance_km: distance,
            duration_min: dur,
            started_at: a.sampled_at,
            ended_at: b.sampled_at,
            battery_delta: pct2,
            elec_kwh: kwh2,
            cost_cny: kwh2 !== null && up2.price !== null ? round(kwh2 * up2.price, 2) : null,
            price_cny: up2.price,
            price_at: up2.at,
            //  D-089：补推行程卡同样带油费（口径与实时一致）
            ...(engineFinal !== null && engineFinal > 0.1 ? await (async () => {
              const fp = await db.currentFuelPrice(D1);
              const fs = await db.getState(D1, `usage:fuel:${vin}`, { l_per_100km: DEFAULT_L_PER_100KM });
              const l100 = num(fs?.l_per_100km, DEFAULT_L_PER_100KM) || DEFAULT_L_PER_100KM;
              const liters = round((engineFinal / 100) * l100, 2);
              return {
                fuel_liters: liters,
                fuel_cost_cny: fp !== null ? round(liters * fp, 2) : null,
                l_per_100km: l100,
                fuel_price_cny: fp,
              };
            })() : {}),
            elec_km: elecFinal,
            engine_km: engineFinal,
            ad_km: adKm,
            start_loc: route?.start_loc || locLabel(startPos, geos),
            end_loc: route?.end_loc || locLabel(endPos, geos),
            route_km: route?.km ?? null,
            route_url: await tripShareUrl(env, id),
          },
        }));
        out.pushed.push({ key, ok: res.ok });
        log("回溯补推行程卡 →", a.sampled_at, distance, "km", res.ok ? "已推送" : "推送失败");
      }
    }
  }
  return out;
}

/**
 * 站点根地址。卡片里的「查看本次线路图」按钮和线路图截图都要拼绝对地址，
 * 而 Worker 运行期拿不到「自己的公网域名」——所以由 wrangler.jsonc 的
 * PUBLIC_BASE_URL 提供（部署到自己的 workers.dev / 自定义域名后填这里）。
 * 没配置时返回空串，调用方各自降级（分享链接 → 不给按钮；截图 → 纯文字卡）。
 */
function publicBase(env) {
  const b = (env && (env.PUBLIC_BASE_URL || env.PUBLIC_BASE)) || "";
  return String(b).replace(/\/+$/, "");
}

/**
 * 取推送目标（D-086）：该类推送被用户关掉时返回 null，
 * 调用方原有的 `target ? push : skip` 逻辑就会自然跳过，不必改结构。
 */
async function pushTarget(D1, kind) {
  if (!(await isPushOn(D1, kind))) return null;
  return db.getState(D1, "feishu:target");
}

/**
 * 行程卡里的线路图链接（D-079）
 * 原来指向面板 `/?trip=<id>`，需要登录 cookie —— 手机上从飞书点开必然 401（"bad token"）。
 * 改用**单条行程的签名短链**：免登录、14 天过期、只含这一条行程，外泄损失可控。
 * 签名失败时退回面板链接（总比没有链接好），不阻塞推卡。
 */
async function tripShareUrl(env, tripId) {
  if (!tripId) return null;
  // base 必须声明在 try 外面：catch 分支（签名失败）还要用它，写在 try 里会 ReferenceError
  const base = publicBase(env);
  if (!base) return null;
  try {
    return `${base}/t/${await signTripToken(env, tripId)}`;
  } catch {
    return `${base}/?trip=${tripId}`;
  }
}

/**
 * 行程线路图截图并上传飞书（D-082）
 * 链路：签名短链 ?embed=1 → Browser Rendering 截图 → im/v1/images 上传 → image_key
 * 任何一步失败都返回 null（调用方降级成纯文字卡），绝不影响推卡。
 * 护栏：里程 < SHOT_MIN_KM 不截；每天最多 SHOT_DAILY_CAP 张（Free 版浏览器额度 10 分钟/天）。
 */
export async function shootTripImage(env, D1, vin, tripId, distanceKm) {
  const log = () => {};
  return attachTripImage(env, D1, vin, tripId, distanceKm, log);
}

async function attachTripImage(env, D1, vin, tripId, distanceKm, log = () => {}) {
  if (!tripId || !(Number(distanceKm) >= SHOT_MIN_KM) || !hasBrowser(env)) return null;
  const key = `usage:shots:${shanghaiDate()}`;
  try {
    const used = Number(((await db.getState(D1, key)) || {}).count || 0);
    if (used >= SHOT_DAILY_CAP) {
      log(`截图额度已用满（${used}/${SHOT_DAILY_CAP}）→ 纯文字卡`);
      return null;
    }
    const token = await signTripToken(env, tripId);
    const base = publicBase(env);
    if (!base) { log("未配置 PUBLIC_BASE_URL → 跳过线路图截图"); return null; }
    const shot = await screenshotPage(env, `${base}/t/${token}?embed=1`);
    await db.setState(D1, key, { count: used + 1, at: shanghaiNow(), last_ms: shot.browserMs });
    try {
      await env.MEDIA.put(`trip/${vin}/${tripId}.png`, shot.bytes, { httpMetadata: { contentType: shot.contentType } });
    } catch { /* R2 只是备份，失败不影响卡片 */ }
    const imageKey = await uploadImage(env, shot.bytes, shot.contentType, `trip-${tripId}.png`);
    log(`线路图截图 ${(shot.bytes.length / 1024).toFixed(0)}KB · 浏览器 ${shot.browserMs}ms · 今日第 ${used + 1} 张`);
    return imageKey;
  } catch (err) {
    log("线路图截图失败（降级纯文字卡）:", err.message);
    return null;
  }
}

// ── 用车电价口径（D-078）─────────────────────────────────────
// 用户 2026-11-04 明确指出：电费必须按「充进去那一刻的电价」结算，
// 然后一直沿用到下一次充电 —— 因为车上存的电就是那个价买来的。
// 旧实现用「推送时刻的分时电价」（日报 0 点跑 → 命中 22:00–24:00 档），
// 用户看到的 0.89 元/度就是这么来的，和实际充电价无关。
const DEFAULT_KWH_PER_PCT = 0.31; // 实测：2026-11-02 充 24.21 kWh / SOC 14%→92%（Δ78%）

/**
 * 某个时刻「车上电量」的单价：取该时刻之前最近一次充电的实际电价。
 * 从未充过电才回退平铺价（0.898）。
 */
async function usagePrice(D1, vin, atTs) {
  const cached = await db.getState(D1, "usage:price");
  const last = await db.lastChargePrice(D1, vin, atTs || null);
  const price = last?.price_per_kwh ?? cached?.price ?? (await db.currentPrice(D1));
  return {
    price: price === null || price === undefined ? null : Number(price),
    kwh_per_pct: num(cached?.kwh_per_pct, DEFAULT_KWH_PER_PCT) || DEFAULT_KWH_PER_PCT,
    at: last?.started_at ?? cached?.at ?? null,
  };
}

/**
 * 一次充电结束后刷新「用车电价」基准：
 *   price        = 这次充电的加权平均单价（分时价按分钟加权）
 *   kwh_per_pct  = 充入电量 / SOC 增幅（用充电起止时刻的电量采样反推）
 */
async function refreshUsagePrice(D1, vin, session) {
  if (!session || session.price_per_kwh === null || session.price_per_kwh === undefined) return;
  const prev = await db.getState(D1, "usage:price");
  let kwhPerPct = null;
  const b0 = session.started_at ? await db.batteryNear(D1, vin, session.started_at) : null;
  const b1 = session.ended_at ? await db.batteryNear(D1, vin, session.ended_at) : null;
  const dPct = b0 !== null && b1 !== null ? b1 - b0 : null;
  if (dPct !== null && dPct >= 5 && session.capacity_kwh) {
    kwhPerPct = round(session.capacity_kwh / dPct, 3);
  }
  await db.setState(D1, "usage:price", {
    price: Number(session.price_per_kwh),
    kwh_per_pct: kwhPerPct ?? num(prev?.kwh_per_pct, DEFAULT_KWH_PER_PCT),
    session_key: session.session_key,
    at: session.ended_at || session.started_at || shanghaiNow(),
    battery_from: b0, battery_to: b1,
  });
}

/**
 * 建行程线：**直接用车辆原始采样轨迹**（D-085）。
 *
 * 为什么不再用高德路径规划：2km 两个锚点 + 默认「速度优先」策略，会让规划器在并行走廊上
 * 挑大路 —— 实测 2026-11-04 17:33 那趟把实际走的「富山一路」画成了「富山中大道」，
 * 最大偏差 683m（用户投诉）。改用真实点做途经点虽能贴合到 3m，但规划里程虚高 70%
 * （31.9km vs 里程表 18.6km）。⇒ 几何以真实轨迹为准，只做 Chaikin 平滑；
 * 里程用里程表（trip.distance_km），不再输出 route_km。
 *
 * 只剩 2 次逆地理调用（起止地点名），失败不影响出图（D-073 降级原则）。
 */
async function buildTripRoute(env, D1, vin, tripId, from, to, startPos, endPos) {
  if (!tripId) return null;
  const rows = await db.listPositionsBetween(D1, vin, from, to);
  if (rows.length < 2) {
    await db.updateTripRoute(D1, tripId, { route_error: `采样点不足（${rows.length}）` });
    return null;
  }

  // WGS-84 → GCJ-02（高德底图坐标系）后过点平滑；45 点 × 8 ≈ 350 点，曲线严格穿过每个采样点
  const raw = rows.map((p) => {
    const g = wgs2gcj(p.lat, p.lon);
    return { lat: g.lat, lon: g.lon };
  });
  const points = smoothPath(raw, 8);
  const json = JSON.stringify(points.map((p) => [+Number(p.lon).toFixed(5), +Number(p.lat).toFixed(5)]));

  // 起止地点名：优先逆地理（"示例路示例小区(南门)" 这种），失败就留空沿用围栏名
  let startLoc = null;
  let endLoc = null;
  let err = null;
  try {
    if (startPos) startLoc = (await regeo(env, startPos)).address;
    if (endPos && (!startPos || Math.abs(endPos.lat - startPos.lat) + Math.abs(endPos.lon - startPos.lon) > 0.0002)) {
      endLoc = (await regeo(env, endPos)).address;
    }
  } catch (e) {
    err = `逆地理失败: ${e.message}`;
  }

  await db.updateTripRoute(D1, tripId, {
    route_points: json,
    route_km: null,
    route_source: "raw",
    route_error: err,
    start_loc: startLoc,
    end_loc: endLoc,
  });
  return { km: null, source: "raw", samples: rows.length, start_loc: startLoc, end_loc: endLoc };
}

// ── 自适应轮询（D-093）：静止就拉长间隔，一有变化立刻回 60s ──
const POLL = {
  activeSec: 60,
  outSec: 120,        // 在外静止
  homeSec: 180,       // 在家静止
  maxSec: 300,        // 兜底最长
  idleShortMs: 10 * 60_000,
  idleLongMs: 30 * 60_000,
  forceAfterMs: 5 * 60_000,
  moveM: 30,
};

function detectChange(sample, prev, lastPos) {
  if (!sample) return true;
  if (!prev) return true;
  const odo = Number(sample.odometer_km ?? 0);
  const pOdo = Number(prev.odometer_km ?? 0);
  if (Math.abs(odo - pOdo) > 0.05) return true;
  if (Number(sample.battery ?? -1) !== Number(prev.battery ?? -2)) return true;
  if (Number(sample.speed ?? 0) > 0 || Number(prev.speed ?? 0) > 0) return true;
  if (!!sample.charging !== !!prev.charging) return true;
  if (String(sample.charge_status ?? "") !== String(prev.charge_status ?? "")) return true;
  if (sample.position && lastPos && haversineM(sample.position, lastPos) > POLL.moveM) return true;
  return false;
}

async function nextPollPlan(D1, vin, sample, prev) {
  const nowMs = Date.now();
  const old = (await db.getState(D1, "poll:plan", null)) || {};
  const lastPos = old.last_pos || null;
  const changed = detectChange(sample, prev, lastPos);
  let lastChange = Number(old.last_change_at_ms) || nowMs;
  if (changed) lastChange = nowMs;
  const idleMs = Math.max(0, nowMs - lastChange);

  let atHome = false;
  if (sample?.position) {
    try {
      const geos = await db.listGeofences(D1, vin);
      atHome = (geos || []).some((g) => haversineM(sample.position, { lat: g.lat, lon: g.lon }) <= Number(g.radius_m || 400) * 1.15);
    } catch { /* ignore */ }
  }

  const charging = !!sample?.charging;
  const moving = Number(sample?.speed || 0) > 0;
  const lastPoll = Number(old.last_at_ms) || 0;
  let interval, mode;
  if (lastPoll && nowMs - lastPoll > POLL.forceAfterMs) { interval = POLL.activeSec; mode = "recover"; }
  else if (charging) { interval = POLL.activeSec; mode = "charging"; }
  else if (moving) { interval = POLL.activeSec; mode = "moving"; }
  else if (idleMs < POLL.idleShortMs) { interval = POLL.activeSec; mode = "just-stopped"; }
  else if (atHome && idleMs >= POLL.idleLongMs) { interval = POLL.homeSec; mode = "home-idle"; }
  else { interval = POLL.outSec; mode = "out-idle"; }
  if (interval > POLL.maxSec) interval = POLL.maxSec;

  const today = shanghaiNow().slice(0, 10);
  const pollsToday = old.polls_date === today ? Number(old.polls_today || 0) + 1 : 1;

  const plan = {
    started_at_ms: Number(old.started_at_ms) || nowMs,
    polls_date: today,
    polls_today: pollsToday,
    next_at_ms: nowMs + interval * 1000,
    interval_sec: interval,
    mode,
    changed,
    at_home: atHome,
    last_change_at_ms: lastChange,
    last_at_ms: nowMs,
    last_pos: sample?.position || lastPos,
  };
  await db.setState(D1, "poll:plan", plan);
  return plan;
}

async function handleTrip(env, D1, client, vehicle, sample, trip, results, log, prevSample = null) {
  const vin = vehicle.vin;
  if (!trip || trip.mileage_km === null) return;
  const st = await db.getState(D1, `trip:${vin}`, { active: null });
  const odo = trip.mileage_km;
  const now = sample.sampled_at;
  const nowMs = parseShanghai(now)?.getTime() || Date.now();
  const pos = sample.position || null;

  if (!st.active) {
    // 无进行中的行程 → 检测里程是否刚增加
    // 用调用方传进来的「上一帧」（saveSample 之前取的），见 D-077
    const last = prevSample;
    if (last && last.odometer_km !== null) {
      const delta = odo - last.odometer_km;
      if (delta > TRIP_MIN_KM) {
        st.active = {
          started_at: last.sampled_at,
          start_odo: last.odometer_km,
          last_odo: odo,
          last_change_at: now,
          start_battery: last.battery,
          // 车机累积值快照（行程结束时差分）
          start_cd: trip.cd_km, end_cd: trip.cd_km,
          start_eng: trip.engine_km, end_eng: trip.engine_km,
          start_ad: trip.ad_km, end_ad: trip.ad_km,
          start_pos: pos, end_pos: pos,
        };
        await db.setState(D1, `trip:${vin}`, st);
      }
    }
    return;
  }

  const t = st.active;
  const moved = odo - (num(t.last_odo, num(t.start_odo, odo)));
  if (moved > 0) {
    // 还在走：刷新里程与快照（若已进入结算等待，说明车又动了 → 取消结算继续行程）
    t.settling = false;
    t.last_odo = odo;
    t.last_change_at = now;
    t.end_cd = trip.cd_km;
    t.end_eng = trip.engine_km;
    t.end_ad = trip.ad_km;
    if (pos) t.end_pos = pos;
    await db.setState(D1, `trip:${vin}`, st);
    return;
  }

  // 里程不再增长 → 停滞超过阈值即判定结束
  const idleMs = nowMs - (parseShanghai(t.last_change_at)?.getTime() || 0);
  if (!t.settling) {
    if (idleMs <= TRIP_IDLE_MIN * 60_000) return;
    //  D-089：先进入「结算等待」，不立刻算纯电/发动机。
    //   实测（2026-11-05 12:16 行程）：车机 odometer 实时增长，但
    //   Trip.Total.cdMileage / engineMileage 是【滞后同步】的 —— 行程结束瞬间
    //   cd 只追到 +0.4 km，实际已走 1.5 km，约 10 分钟后才补到 +1.5 km。
    //   若当场差分，纯电被低估、发动机被系统性高估（把电算成油）。
    t.settling = true;
    t.settled_at = now;
    t.end_odo = odo;
    t.end_cd = trip.cd_km;
    t.end_eng = trip.engine_km;
    if (pos) t.end_pos = pos;
    await db.setState(D1, `trip:${vin}`, st);
    return;
  }

  // 结算等待中：每轮刷新车机累计值，直到「纯电+发动机增量」追上总里程，或超时
  if (trip.cd_km !== null && trip.cd_km !== undefined) t.end_cd = Math.max(num(t.end_cd, trip.cd_km), trip.cd_km);
  if (trip.engine_km !== null && trip.engine_km !== undefined) t.end_eng = Math.max(num(t.end_eng, trip.engine_km), trip.engine_km);
  if (pos) t.end_pos = pos;
  const distance = round(num(t.end_odo, odo) - t.start_odo, 1);
  const cdDelta = (t.end_cd !== null && t.end_cd !== undefined && t.start_cd !== null && t.start_cd !== undefined)
    ? round(t.end_cd - t.start_cd, 1) : null;
  const engDelta = (t.end_eng !== null && t.end_eng !== undefined && t.start_eng !== null && t.start_eng !== undefined)
    ? round(t.end_eng - t.start_eng, 1) : null;
  const attributed = (cdDelta || 0) + (engDelta || 0);
  const waitedMs = nowMs - (parseShanghai(t.settled_at)?.getTime() || nowMs);
  if (attributed < distance - 0.3 && waitedMs < TRIP_SETTLE_MIN * 60_000) {
    await db.setState(D1, `trip:${vin}`, st);
    return;
  }
  const endedAt = t.settled_at || now;
  const durationMin = Math.round(((parseShanghai(endedAt)?.getTime() || nowMs) - (parseShanghai(t.started_at)?.getTime() || nowMs)) / 60000);
  const key = `trip:end:${t.started_at}`;
  if (distance > TRIP_MIN_KM && await db.markPushed(D1, vin, key, "feishu", { distance })) {
    //  D-089：纯电 = ΔcdMileage，发动机 = ΔengineMileage（两者都已等到车机同步）。
    //   旧实现用「总里程 − 纯电」反推发动机 → cd 滞后时把纯电行驶算成发动机
    //   （实测 1.5 km 纯电行程被判成 1.1 km 发动机，用户 2026-11-05 报障）。
    const elec = cdDelta !== null ? round(Math.min(Math.max(cdDelta, 0), distance), 1) : null;
    const engine = engDelta !== null
      ? round(Math.min(Math.max(engDelta, 0), Math.max(0, distance - (elec || 0))), 1)
      : (elec !== null ? round(Math.max(0, distance - elec), 1) : null);
    //  D-089：车机两个累计值之和可能小于总里程（历史缺口 1181 km，见 D-059）。
    //   余量归属「当时真正在跑的那个模式」：增程器里程在涨 → 余量算油；否则算电。
    let elecFinal = elec;
    let engineFinal = engine;
    let unattributed = (elec !== null && engine !== null) ? round(Math.max(0, distance - elec - engine), 1) : 0;
    if (unattributed > 0.3 && elecFinal !== null && engineFinal !== null) {
      if (engineFinal > 0.1) engineFinal = round(distance - elecFinal, 1);
      else elecFinal = round(distance - engineFinal, 1);
      unattributed = round(Math.max(0, distance - elecFinal - engineFinal), 1);
    }
    const ad = (t.end_ad !== null && t.end_ad !== undefined && t.start_ad !== null && t.start_ad !== undefined)
      ? round(Math.max(0, t.end_ad - t.start_ad), 1) : null;
    const geos = await db.listGeofences(D1, vin);
    const target = await pushTarget(D1, "trip");

    //  D-078：本程消耗的电费 = |ΔSOC| × kWh/1% × 【上次充电的实际电价】
    const up = await usagePrice(D1, vin, now);
    const pctDelta = (sample.battery !== null && sample.battery !== undefined
      && t.start_battery !== null && t.start_battery !== undefined)
      ? num(sample.battery) - num(t.start_battery) : null;
    //  D-089：只有「真的在用电」（纯电里程 >0.1 且电量下降）才计电费；
    //   增程器发电把电量充上去的行程不能倒算成电费。
    const elecKwh = (pctDelta !== null && pctDelta < 0 && (elecFinal || 0) > 0.1)
      ? round(Math.abs(pctDelta) * up.kwh_per_pct, 2) : null;
    const tripCost = elecKwh !== null && up.price !== null ? round(elecKwh * up.price, 2) : null;
    //  D-089：油费 —— 本程用油才计（发动机里程 × 实测百公里油耗 × 当前油价）
    const fuelPrice = await db.currentFuelPrice(D1);
    const fuelStat = await db.getState(D1, `usage:fuel:${vin}`, { l_per_100km: DEFAULT_L_PER_100KM, samples: 0 });
    const lPer100 = num(fuelStat?.l_per_100km, DEFAULT_L_PER_100KM) || DEFAULT_L_PER_100KM;
    const fuelLiters = engineFinal !== null && engineFinal > 0.1 ? round((engineFinal / 100) * lPer100, 2) : 0;
    const fuelCost = fuelLiters > 0 && fuelPrice !== null ? round(fuelLiters * fuelPrice, 2) : null;

    // ── 落库 + 建线路图（D-076）──
    // 顺序很重要：先落 trip_log 拿到 id，再建线路（可能慢/可能失败），最后推卡把链接带出去。
    // 建线路失败**绝不能影响推卡**（D-073 降级原则），失败只写 route_error 供排查。
    let tripId = null;
    let startLoc = locLabel(t.start_pos, geos);
    let endLoc = locLabel(t.end_pos, geos);
    let routeKm = null;
    try {
      tripId = await db.saveTripLog(D1, {
        vin, started_at: t.started_at, ended_at: endedAt,
        distance_km: distance, duration_min: durationMin,
        elec_km: elecFinal, engine_km: engineFinal, ad_km: ad,
        battery_from: t.start_battery, battery_to: sample.battery,
        start_loc: startLoc, end_loc: endLoc,
        start_lat: t.start_pos?.lat ?? null, start_lon: t.start_pos?.lon ?? null,
        end_lat: t.end_pos?.lat ?? null, end_lon: t.end_pos?.lon ?? null,
        created_at: now,
      });
      const route = await buildTripRoute(env, D1, vin, tripId, t.started_at, now, t.start_pos, t.end_pos);
      if (route) {
        routeKm = route.km;
        if (route.start_loc) startLoc = route.start_loc;
        if (route.end_loc) endLoc = route.end_loc;
      }
    } catch (err) {
      log("行程落库/建线失败（不影响推送）:", err.message);
    }

    const imageKey = target ? await attachTripImage(env, D1, vin, tripId, distance, log) : null;
    const res = target ? await sendCard(env, target, cards.buildTripCard({
      imageKey,
      vehicle: await db.getVehicle(D1),
      icons: await db.getState(D1, "card:icons", null),
      trip: {
        id: tripId,
        distance_km: distance,
        duration_min: durationMin,
        started_at: t.started_at,
        ended_at: endedAt,
        battery_delta: pctDelta,
        //  D-166：实时推送漏传起止电量 → 卡片中间那块「电量变化」永远是 --（用户 2026-11-19 实测）
        battery_from: t.start_battery,
        battery_to: sample.battery,
        elec_kwh: elecKwh,
        cost_cny: tripCost,
        price_cny: up.price,
        price_at: up.at,
        //  D-089：油费字段（本程真的用油时卡片才显示）
        unattributed_km: unattributed,
        fuel_liters: fuelLiters, fuel_cost_cny: fuelCost,
        l_per_100km: lPer100, fuel_price_cny: fuelPrice,
        elec_km: elecFinal, engine_km: engineFinal, ad_km: ad,
        start_loc: startLoc,
        end_loc: endLoc,
        route_km: routeKm,
        route_url: await tripShareUrl(env, tripId),
      },
    })) : { ok: false, msg: "未绑定飞书目标" };
    results.pushed.push({ key, ok: res.ok });
    log("行程结束 →", distance, "km（纯电", elecFinal, "/ 发动机约", engineFinal, "）", res.ok ? "已推送" : "推送失败");
  }
  st.active = null;
  await db.setState(D1, `trip:${vin}`, st);
}

/**
 *  D-090：用 trip_log 里已落库的一行重建行程卡（运维重推用）。
 * 口径与实时路径一致：耗电/电费按「上次充电电价」，油费按「本程发动机里程 × 实测油耗 × 油价」。
 */
export async function buildTripCardForPush(env, D1, vin, trip, imageKey = null) {
  const up = await usagePrice(D1, vin, trip.ended_at || trip.started_at);
  const bf = num(trip.battery_from, null), bt = num(trip.battery_to, null);
  const pctDelta = bf !== null && bt !== null ? bt - bf : null;
  const elecKm = num(trip.elec_km, null), engineKm = num(trip.engine_km, null);
  const elecKwh = (pctDelta !== null && pctDelta < 0 && (elecKm || 0) > 0.1)
    ? round(Math.abs(pctDelta) * up.kwh_per_pct, 2) : null;
  const tripCost = elecKwh !== null && up.price !== null ? round(elecKwh * up.price, 2) : null;
  const fuelPrice = await db.currentFuelPrice(D1);
  const fuelStat = await db.getState(D1, `usage:fuel:${vin}`, { l_per_100km: DEFAULT_L_PER_100KM, samples: 0 });
  const lPer100 = num(fuelStat?.l_per_100km, DEFAULT_L_PER_100KM) || DEFAULT_L_PER_100KM;
  const fuelLiters = engineKm !== null && engineKm > 0.1 ? round((engineKm / 100) * lPer100, 2) : 0;
  const fuelCost = fuelLiters > 0 && fuelPrice !== null ? round(fuelLiters * fuelPrice, 2) : null;
  //  D-154：最高车速＝行程时间窗内采样的峰值（只读已有 signal_sample，不新增采集）；
  //   离家最远＝轨迹点距「家」围栏中心的最大直线距离（纯几何，不调逆地理）。
  let maxSpeedKmh = null;
  try {
    const q = await D1.prepare(
      "SELECT MAX(speed) AS mx FROM signal_sample WHERE vin=? AND sampled_at>=? AND sampled_at<=?",
    ).bind(vin, trip.started_at, trip.ended_at || trip.started_at).first();
    const mx = num(q?.mx, null);
    if (mx !== null && mx > 0) maxSpeedKmh = Math.round(mx);
  } catch (e) {
    console.warn("[trip] 最高车速查询失败:", e?.message);
  }
  let maxDistKm = null;
  try {
    // listTripLogs 为了轻量没带 route_points，这里按 id 单取一次（只有算「离家最远」时才查）
    let rawRoute = trip.route_points;
    if (rawRoute == null && trip.id != null) {
      const row = await D1.prepare("SELECT route_points FROM trip_log WHERE id=?").bind(trip.id).first();
      rawRoute = row?.route_points ?? null;
    }
    let pts = [];
    if (Array.isArray(rawRoute)) pts = rawRoute;
    else if (typeof rawRoute === "string" && rawRoute) {
      try { pts = JSON.parse(rawRoute); } catch { pts = []; }
    }
    const home = (await db.listGeofences(D1, vin)).find((g) => g.label === "家" && g.lat != null && g.lon != null);
    if (home && pts.length) {
      const R = 6371.0088;
      const rad = (d) => (d * Math.PI) / 180;
      let best = 0;
      for (const p0 of pts) {
        const lat = num(Array.isArray(p0) ? p0[1] : p0?.lat, null);
        const lon = num(Array.isArray(p0) ? p0[0] : p0?.lon, null);
        if (lat === null || lon === null) continue;
        const dLat = rad(lat - num(home.lat));
        const dLon = rad(lon - num(home.lon));
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat)) * Math.cos(rad(num(home.lat))) * Math.sin(dLon / 2) ** 2;
        const d = 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
        if (d > best) best = d;
      }
      if (best > 0) maxDistKm = round(best, 1);
    }
  } catch (e) {
    console.warn("[trip] 离家最远计算失败:", e?.message);
  }
  return cards.buildTripCard({
    imageKey,
    vehicle: await db.getVehicle(D1),
    icons: await db.getState(D1, "card:icons", null),
    trip: {
      id: trip.id,
      distance_km: num(trip.distance_km),
      duration_min: num(trip.duration_min),
      started_at: trip.started_at,
      ended_at: trip.ended_at,
      battery_delta: pctDelta,
      //  D-153：折叠里要显示「82% → 66%」，所以把起止值一并传给卡片
      battery_from: bf,
      battery_to: bt,
      max_speed_kmh: maxSpeedKmh,
      max_dist_km: maxDistKm,
      elec_kwh: elecKwh,
      cost_cny: tripCost,
      price_cny: up.price,
      price_at: up.at,
      fuel_liters: fuelLiters,
      fuel_cost_cny: fuelCost,
      l_per_100km: lPer100,
      fuel_price_cny: fuelPrice,
      elec_km: elecKm,
      engine_km: engineKm,
      ad_km: num(trip.ad_km, null),
      start_loc: trip.start_loc,
      end_loc: trip.end_loc,
      route_km: num(trip.route_km, null),
      route_url: await tripShareUrl(env, trip.id),
    },
  });
}

/**
 *  D-078：按【分时电价表】重算历史充电会话的电价与电费，并重算日汇总电费。
 *
 * 为什么需要：D-068（2026-11-03）之前所有会话都是按平铺 0.62 结算的，
 * 而真实分时价是 0.68 / 0.90 / 1.15。不修正的话「上次充电电价」这个基准
 * 一开始就是错的（0.62），后面所有日报/行程卡都会跟着错。
 *
 * 同时清理重复会话：每天一次的 charge_sync 会按 millis 键给同一次充电再建一行。
 */
export async function repriceHistory(env, D1, vin, log = () => {}) {
  const out = { sessions: 0, repriced: 0, deduped: 0, dailies: 0, usage: null };
  const sessions = (await db.listChargeSessions(D1, vin, 500)) || [];
  out.sessions = sessions.length;

  // 1) 去重：session_key 是毫秒串（charge_sync 建的、没有 ended_at）且存在同 started_at 的实时行 → 删
  for (const s of sessions) {
    if (!/^\d{10,}\|/.test(String(s.session_key))) continue;
    // 同一次充电：charge_sync 建的行 started_at 可能比实时行早 1 秒 → 用 ±5 分钟窗口判重
    const twin = sessions.find((o) => o.session_key !== s.session_key && o.ended_at
      && (shanghaiDiffMs(o.started_at, s.started_at) ?? Infinity) < 5 * 60_000);
    if (twin) {
      await db.deleteChargeSession(D1, vin, s.session_key);
      out.deduped += 1;
    }
  }

  // 2) 按起止时刻的分时加权价重算每条会话
  const fresh = (await db.listChargeSessions(D1, vin, 500)) || [];
  for (const s of fresh) {
    if (!s.started_at) continue;
    const pw = await db.elecPriceWindow(D1, s.started_at, s.ended_at || s.started_at);
    if (pw.avg === null || pw.avg === undefined) continue;
    const capacity = num(s.capacity_kwh, null);
    const cost = capacity !== null ? round(capacity * pw.avg, 2) : s.cost_cny;
    if (Math.abs(num(s.price_per_kwh, 0) - pw.avg) <= 0.005 && num(s.cost_cny, null) !== null) continue;
    await db.upsertChargeSession(D1, { ...s, price_per_kwh: pw.avg, cost_cny: cost });
    out.repriced += 1;
  }

  // 3) 重算日汇总电费：当天有充电 → 用会话实际值；否则「当日耗电 × 当日之前最近一次充电电价」
  const today = shanghaiDate();
  const from = shanghaiDate(new Date(Date.now() - 120 * 24 * 3600 * 1000));
  const dailies = (await db.listDaily(D1, vin, from, today)) || [];
  for (const d of dailies) {
    const daySessions = await db.listChargeSessionsOnDate(D1, vin, d.stat_date);
    const sessionCost = daySessions.reduce((a, x) => a + (num(x.cost_cny, 0) || 0), 0);
    const up = await usagePrice(D1, vin, `${d.stat_date} 23:59:59`);
    const cost = sessionCost > 0 ? round(sessionCost, 2)
      : (up.price !== null ? round(num(d.elec_kwh, 0) * up.price, 2) : num(d.cost_cny, 0));
    if (Math.abs(num(d.cost_cny, 0) - cost) > 0.005) {
      await db.upsertDaily(D1, { ...d, cost_cny: cost });
      out.dailies += 1;
    }
  }

  // 4) 用最新一次会话刷新「用车电价」基准
  const latest = await db.lastChargePrice(D1, vin, null);
  if (latest) {
    await refreshUsagePrice(D1, vin, latest);
    out.usage = await db.getState(D1, "usage:price");
  }
  log(`重算完成：会话 ${out.sessions} 条（改价 ${out.repriced}，去重 ${out.deduped}），日汇总改 ${out.dailies} 天`);
  return out;
}

/**
 *  D-069：地理围栏 —— 到时 / 离家提醒。
 *   数据源 = 每分钟一个位置采样（D-068 修好后才有数据）。
 *   判定：进入用 `radius_m`，离开用 `radius_m × 1.15`（滞回，防 GPS 抖动来回刷）；
 *   进入后需持续 `dwell_sec` 才算「到家」（路过不算）。
 *   幂等：`geo:<vin>:<label>:<dir>:<分钟>` + state 里的 notified 双保险。
 */
const GEO_LEAVE_HYST = 1.15;

// 到家卡等照片的窗口（毫秒）：超过就推纯文字卡，之后照片到了也不再补（用户 m02764 要求）
const HOME_PHOTO_WAIT_MS = 3 * 60 * 1000;

// 到家判定时如果 park:last 的照片是最近 10 分钟内拍的，就直接回填（D-175）
const HOME_BACKFILL_MS = 10 * 60 * 1000;

/** 挂起的到家卡：等照片超时 → 推文字卡并清空挂起状态。 */
async function flushPendingStop(env, D1, vehicle, results, log) {
  const vin = vehicle.vin;
  const p = await db.getState(D1, `home:pending:${vin}`, null);
  if (!p || !p.at) return;
  const atMs = parseShanghai(p.at)?.getTime() || 0;
  if (Date.now() - atMs < HOME_PHOTO_WAIT_MS) return;
  await db.setState(D1, `home:pending:${vin}`, null);
  const target = await pushTarget(D1, "geo");
  if (!target) return;
  const res = await sendCard(env, target, cards.buildStopCard({
    kind: "home", at: p.at, battery: p.battery, range: p.range, label: p.label,
    sentinelText: p.sentinel, locked: p.locked, distanceM: p.distanceM, images: [],
    vehicle, icons: await db.getState(D1, "card:icons", null),
  }));
  results.pushed.push({ key: p.key, ok: res.ok, note: "超时无照片" });
  log("到家等照片超时 → 已推文字卡", res.ok ? "ok" : "失败");
}

async function handleGeofence(env, D1, vehicle, sample, results, log) {
  const vin = vehicle.vin;
  const pos = sample.position;
  if (!pos || pos.lat === null || pos.lon === null) return;   // GPS 无效（停车久未定位）→ 跳过
  const geos = await db.listGeofences(D1, vin);
  if (!geos.length) return;

  const key = `geo:${vin}`;
  const st = (await db.getState(D1, key, null)) || {};
  const now = sample.sampled_at;
  const nowMs = parseShanghai(now)?.getTime() || Date.now();
  const target = await pushTarget(D1, "geo");
  let changed = false;

  for (const g of geos) {
    const prev = st[g.label] || { inside: false, since: now, notified: null };
    const radius = num(g.radius_m, 500) || 500;
    const dwell = num(g.dwell_sec, 300) || 0;
    const dist = haversine(pos.lat, pos.lon, g.lat, g.lon);
    const inside = dist <= (prev.inside ? radius * GEO_LEAVE_HYST : radius);

    //  先记住「离开前是否已通知过到达」：下面的重置会把 notified 清掉，
    //   若不留快照，离开事件永远不会触发（单测抓到）。
    const wasNotifiedIn = prev.notified === "in";
    //  D-198：离开卡要报「在家停留」多久 → 得知道什么时候进来的。prev.since 在下面
    //  边界翻转时会被重置成 now，所以必须在这里先取一份（此时 prev.inside 还是旧值 true）。
    const enteredAt = prev.inside ? prev.since : null;

    if (inside !== prev.inside) {
      // 边界变化 → 重置停留计时与通知标记
      prev.inside = inside;
      prev.since = now;
      prev.notified = null;
      changed = true;
    }

    if (inside && prev.notified !== "in") {
      const sinceMs = parseShanghai(prev.since)?.getTime();
      const dwellMs = sinceMs ? nowMs - sinceMs : 0;
      if (dwellMs >= dwell * 1000) {
        const pk = `geo:${vin}:${g.label}:in:${now.slice(0, 16)}`;
        if (await db.markPushed(D1, vin, pk, "feishu", { label: g.label, dir: "in" })) {
          // D-141：到家卡要合并泊车照片，先挂起；3 分钟内等到照片就带图推，等不到推文字卡
          const detail = await db.getState(D1, "last:detail", null);
          //  D-175：照片可能比「到家」判定更早到（实测 17:59 拍照 / 18:03 才判定到家，
          //  因为停车照走实时链路、围栏要等 dwell）。这种情况不能干等 3 分钟——
          //  直接把 park:last 里的照片回填进这张到家卡，并清掉 keys 防止重复使用。
          const pl = await db.getState(D1, `park:last:${vin}`, null);
          const plMs = pl?.at ? (parseShanghai(pl.at)?.getTime() || 0) : 0;
          const canBackfill = Boolean(pl?.keys?.length) && plMs > 0 && Math.abs(nowMs - plMs) <= HOME_BACKFILL_MS;
          if (canBackfill) {
            await db.setState(D1, `park:last:${vin}`, { ...pl, keys: [] });
            const bres = target
              ? await sendCard(env, target, cards.buildStopCard({
                  kind: "home", at: now, battery: sample.battery, range: sample.range_km, label: g.label,
                  sentinelText: detail?.sentinel_text ?? null, locked: detail?.locked ?? null,
                  distanceM: dist, images: pl.keys, vehicle,
                  icons: await db.getState(D1, "card:icons", null),
                }))
              : { ok: false, msg: "未绑定飞书目标" };
            results.pushed.push({ key: pk, ok: bres.ok, note: `回填照片 ${pl.keys.length} 张` });
            log(`进入「${g.label}」→ 照片已在线，直接带 ${pl.keys.length} 张推送`);
          } else {
            await db.setState(D1, `home:pending:${vin}`, {
              key: pk, at: now, label: g.label,
              battery: sample.battery, range: sample.range_km, distanceM: dist,
              sentinel: detail?.sentinel_text ?? null, locked: detail?.locked ?? null,
            });
            results.pushed.push({ key: pk, ok: true, note: "等待照片" });
            log(`进入「${g.label}」→ 等待照片（最多 3 分钟）`);
          }
        }
        prev.notified = "in";
        changed = true;
      }
    } else if (!inside && wasNotifiedIn) {
      // 之前在里面且已通知过到达 → 现在是离开
      const pk = `geo:${vin}:${g.label}:out:${now.slice(0, 16)}`;
      if (await db.markPushed(D1, vin, pk, "feishu", { label: g.label, dir: "out" })) {
        const res = target
          ? await sendCard(env, target, cards.buildDepartureCard({
              at: now, battery: sample.battery, range: sample.range_km,
              fuelLevel: (await db.getState(D1, "last:detail", null))?.fuel_level ?? null,
              homeSince: enteredAt,
              label: g.label, vehicle, icons: await db.getState(D1, "card:icons", null),
            }))
          : { ok: false, msg: "未绑定飞书目标" };
        results.pushed.push({ key: pk, ok: res.ok });
        log(`离开「${g.label}」→`, res.ok ? "已推送" : "推送失败");
      }
      prev.notified = "out";
      changed = true;
    }
    st[g.label] = prev;
  }

  if (changed) await db.setState(D1, key, st);
}

/** 每日任务：拉昨日日汇总 → 落库 → 推日报；同步充电会话 */
async function dailyTask(env, D1, client, vehicle, results, log) {
  const vin = vehicle.vin;
  const yesterday = shanghaiDate(new Date(Date.now() - 24 * 3600 * 1000));

  const done = await db.getState(D1, `daily:${vin}:${yesterday}`);
  if (!done?.done) {
    const path = `/ssp-travel-x-service/v1-0/travel/daily/aggregate/${vin}` +
      `?startDate=${yesterday}&endDate=${yesterday}`;
    const r = await client.travel(path);
    if (r.code === 0 && r.data) {
      const d = r.data;
      const travelKm = num(d.travelMileage);
      const elecKm = num(d.elecMileage);
      const hybridKm = num(d.hybridMileage);
      const elecKwh = num(d.elecEnergy);
      const fuelL = num(d.fuelConsumption);
      const fuelPrice = await db.currentFuelPrice(D1);
      //  D-078：用车电费 = 消耗电量 × 【该日之前最近一次充电的实际电价】。
      //   旧实现用「推送时刻的分时电价」→ 日报 0 点跑会命中 22:00–24:00 档（0.89），
      //   与用户实际充电价无关。
      const up = await usagePrice(D1, vin, `${yesterday} 23:59:59`);
      const price = up.price;
      //  D-069：电费优先用「当天充电会话按分时电价结算的实际值」，
      //   没有会话（比如随车充没被识别）才回退「电量 × 平铺电价」。
      const daySessions = await db.listChargeSessionsOnDate(D1, vin, yesterday);
      const sessionCost = daySessions.reduce((a, s) => a + (num(s.cost_cny, 0) || 0), 0);
      const sessionKwh = daySessions.reduce((a, s) => a + (num(s.capacity_kwh, 0) || 0), 0);
      const cost = sessionCost > 0 ? round(sessionCost, 2) : (price !== null ? round(elecKwh * price, 2) : 0);
      const fuelCost = fuelPrice !== null ? round(fuelL * fuelPrice, 2) : 0;

      // 智驾里程增量（车机行程表累计值差）
      const prev = await db.getState(D1, `tripcums:${vin}`, null);
      const trip = parseTripTotal(await client.getVss(["Vehicle.Carcenter.Trip.Total"]));
      const adDelta = prev?.ad_km !== null && prev?.ad_km !== undefined && trip?.ad_km !== null && trip?.ad_km !== undefined
        ? round(Math.max(0, trip.ad_km - prev.ad_km), 1) : null;
      const noaDelta = prev?.noa_km !== null && prev?.noa_km !== undefined && trip?.noa_km !== null && trip?.noa_km !== undefined
        ? round(Math.max(0, trip.noa_km - prev.noa_km), 1) : null;
      await db.setState(D1, `tripcums:${vin}`, { ad_km: trip?.ad_km ?? null, noa_km: trip?.noa_km ?? null });

      const stat = {
        vin, stat_date: yesterday,
        travel_km: travelKm, elec_km: elecKm, hybrid_km: hybridKm,
        elec_kwh: elecKwh, fuel_l: fuelL,
        avg_elec_kwh_per_100km: num(d.avgElecEnergy, null),
        avg_fuel_l_per_100km: num(d.avgFuelConsumption, null),
        ad_km: adDelta, noa_km: noaDelta,
        charge_kwh: round(sessionKwh, 2), charge_times: daySessions.length,
        cost_cny: cost, fuel_cost_cny: fuelCost,
        source: "travel",
      };
      await db.upsertDaily(D1, stat);

      //  D-089：刷新「实测百公里油耗」基准（最近 30 天有混动里程的天加权平均），
      //   供行程卡的油费估算使用；数据不足 30 km 时保留旧值/兜底值。
      try {
        const since = shanghaiDate(new Date(Date.now() - 30 * 24 * 3600 * 1000));
        const rows = (await db.listDaily(D1, vin, since, yesterday)) || [];
        let lSum = 0, kmSum = 0;
        for (const r of rows) { lSum += num(r.fuel_l, 0); kmSum += num(r.hybrid_km, 0); }
        if (kmSum >= 30 && lSum > 0) {
          await db.setState(D1, `usage:fuel:${vin}`, {
            l_per_100km: round((lSum / kmSum) * 100, 2),
            hybrid_km: round(kmSum, 1), days: rows.length, at: yesterday,
          });
        }
      } catch { /* 基准刷新失败不影响日报 */ }

      const key = `daily:${vin}:${yesterday}`;
      if (await db.markPushed(D1, vin, key, "feishu", stat)) {
        const target = await db.getState(D1, "feishu:target");
        const res = target ? await sendCard(env, target, cards.buildDailyCard({
          d: stat, priceCny: price, fuelPriceCny: fuelPrice, dateLabel: yesterday,
          priceNote: up.at ? `按 ${String(up.at).slice(5, 16)} 那次充电的电价` : "按默认电价",
        })) : { ok: false, msg: "未绑定飞书目标" };
        results.pushed.push({ key, ok: res.ok });
        log("日报 →", res.ok ? "已推送" : `推送失败 ${res.raw || ""}`);
      }
      await db.setState(D1, `daily:${vin}:${yesterday}`, { done: true, at: shanghaiNow() });
      await db.healthUpsert(D1, vin, "daily", true, null);
    } else {
      await db.healthUpsert(D1, vin, "daily", false, `code=${r.code}`);
    }
  }

  // 同步充电会话（每天一次）
  const syncKey = `charge_sync:${vin}:${yesterday}`;
  if (!(await db.getState(D1, syncKey))?.done) {
    const rows = await fetchChargeSessions(client, vin);
    for (const row of rows) {
      const started = fromMillis(row.startTime);
      if (!started) continue;
      //  D-078：实时状态机已经结算过的会话不要再建一行（否则日报电费翻倍）
      if (await db.hasChargeSessionNear(D1, vin, started)) continue;
      //  D-068：历史行没有结束时间 → 用开始时刻所在时段价
      const price = await db.elecTierPriceAt(D1, started);
      const cap = num(row.chargingCapacity, null);
      await db.upsertChargeSession(D1, {
        vin, session_key: `${row.startTime}|${row.chargingType}`,
        started_at: started,
        capacity_kwh: cap,
        charging_type: row.chargingType,
        // 理想明细只有 4 个字段（无结束时间/电价）→ 电费按「本地电价 × 电量」估算
        cost_cny: cap !== null && price !== null ? round(cap * price, 2) : null,
        price_per_kwh: price,
      });
    }
    await db.setState(D1, syncKey, { done: true, count: rows.length });
  }
}

// ── 加油事件（D-068）──────────────────────────────────────────
const FUEL_TANK_L = 60;             // 油箱容积（用户 2026-11-03 确认：60L）
const FUEL_MIN_RISE = 5;            // 油量上升 ≥5 个百分点才判定加油（整数百分比）
const FUEL_SETTLE_MS = 3 * 60_000;  // 最后一次上升后稳定 3 分钟才算一次加油结束

/**
 * 加油检测：理想【没有】加油事件，也没有加油量/油耗字段，
 * 只有 `MSG_FuelLevelPos` 这个整数百分比 + 燃油续航。
 *
 *   判定开始：油量相对基线上升 ≥5% 且车速 = 0
 *   聚合过程：液位晃动会连跳几次 → 用 pending 记录 from/to，to 取最大值
 *   判定结束：最后一次上升后稳定 3 分钟（`shanghaiDiffMs` 比较，避免 D-064 时区坑）
 *   估算数量：Δ% × 60L / 100（1 个百分点 ≈ 0.6L，误差 ±0.6L）
 *
 * 检测到后推一张「待录入油价」卡；用户回一个数字 → webhook 记价（D-068 路线 B）。
 */
async function handleFuelTransition(env, D1, vehicle, sample, results, log) {
  const vin = vehicle.vin;
  const level = num(sample.fuel_level, null);
  if (level === null) return;
  const key = `fuel:${vin}`;
  const st = (await db.getState(D1, key)) || { level: null, pending: null };

  // 首次采样：只记基线
  if (st.level === null || st.level === undefined) {
    await db.setState(D1, key, { level, pending: null, at: sample.sampled_at });
    return;
  }

  let pending = st.pending || null;
  const rise = level - st.level;

  if (rise >= FUEL_MIN_RISE && num(sample.speed, 0) === 0) {
    // ① 检测到跳变：已有 pending 就续上（取最大），否则新开一个
    pending = pending
      ? { ...pending, to: Math.max(pending.to, level), last_change_at: sample.sampled_at }
      : { from: st.level, to: level, started_at: sample.sampled_at, last_change_at: sample.sampled_at };
  } else if (pending && level !== pending.to) {
    // ② 尾巴：液位继续 ±1% 抖动，归到同一次加油
    pending = { ...pending, to: Math.max(pending.to, level), last_change_at: sample.sampled_at };
  }

  // ③ 稳定 3 分钟 → 结算
  if (pending) {
    const settle = shanghaiDiffMs(sample.sampled_at, pending.last_change_at);
    const stable = level <= pending.to + 1 && level >= pending.to - 1;
    if (settle !== null && settle >= FUEL_SETTLE_MS && stable) {
      const deltaPct = pending.to - pending.from;
      const liters = round((deltaPct * FUEL_TANK_L) / 100, 1);
      const event = {
        at: pending.started_at,
        started_at: pending.started_at,
        ended_at: sample.sampled_at,
        from: pending.from,
        to: pending.to,
        delta_pct: deltaPct,
        liters,
        tank_l: FUEL_TANK_L,
      };
      const pushKey = `fuel:${vin}:${String(event.at).slice(0, 16)}`;
      let messageId = null;
      if (await db.markPushed(D1, vin, pushKey, "feishu", event)) {
        const fuelPrice = await db.currentFuelPrice(D1);
        const fuelPriceRow = await db.currentFuelPriceRow(D1).catch(() => null);
        const target = await pushTarget(D1, "fuel");
        const rangeFuel = num(sample.range_fuel, null);
        const res = target
          ? await sendCard(env, target, cards.buildFuelCard({
              event, lastPriceCny: fuelPrice, lastPriceAt: fuelPriceRow?.effective_from || null, rangeFuel,
              vehicle, icons: await db.getState(D1, "card:icons", null),
            }))
          : { ok: false, msg: "未绑定飞书目标" };
        messageId = res?.data?.message_id || null;
        results.pushed.push({ key: pushKey, ok: res.ok });
        log(`加油完成 +${liters}L（${pending.from}% → ${pending.to}%）→`,
          res.ok ? "已推送" : `推送失败 ${res.raw || ""}`);
      }
      // 记下「等待录入油价」——卡内 form 提交 / 文字回复都用它关联本次加油
      await db.setState(D1, "fuel:pending_price", {
        at: event.at, liters, delta_pct: deltaPct, created_at: shanghaiNow(),
        message_id: messageId,
        started_at: event.started_at, ended_at: event.ended_at,
        from: pending.from, to: pending.to,
        range_fuel: num(sample.range_fuel, null),
        last_price: await db.currentFuelPrice(D1),
      });
      await db.setState(D1, "fuel:last", event);
      // D-093：留档，月报要统计「加了几次油 / 多少升 / 多少钱」
      try {
        const fp = await db.currentFuelPrice(D1);
        await db.saveFuelLog(D1, {
          vin, at: event.at || shanghaiNow(), liters: event.liters ?? null,
          price_cny: fp ?? null,
          cost_cny: event.liters && fp ? Math.round(event.liters * fp * 100) / 100 : null,
          source: "detect",
        });
      } catch (err) { log(`fuel_log 写入失败: ${err.message}`); }
      pending = null;
    }
  }

  await db.setState(D1, key, { level, pending, at: sample.sampled_at });
}

// ── 异常自检 + 告警卡（D-071）──────────────────────────────────────────────
//   用户诉求：「不用天天打开面板，出问题要主动告诉我」。
//   只做「车载数据已经能自证」的四类；**故意不做门窗未关**——
//   停车时人在车里开门/开窗是常态，噪声远大于收益。
const ANOMALY = {
  tireLowKpa: 190,      // < 1.9 bar（正常 2.1~2.5）
  tireHighKpa: 320,     // > 3.2 bar
  tireSpreadKpa: 40,    // 四轮压差 ≥ 40 kPa —— 慢漏气的早期特征
  batteryLowPct: 15,    // 增程车还有油，15% 是「该找桩」而非「要抛锚」
  fuelLowPct: 10,
  plugWaitMin: 30,      // 已插枪但 30 分钟无功率（预约充电除外）
};

const kpa = (v) => (v === null || v === undefined ? "--" : String(Math.round(v)));
const intOrDash = (v) => (v === null || v === undefined ? "--" : String(Math.round(v)));

/** 车辆异常自检 → 有异常才推一张红卡（同类每天最多一条） */
/**
 * 充电建议的判定与数据（D-091）
 * 触发条件：在家（围栏内） + 未充电/未插枪 + 电量 ≤ 30% + 当前不在谷时段
 *   门槛从 50% 下调到 30%（D-174）：增程车 40% 属于日常区间，50% 就推等于天天提醒。
 * 用「首页最小电价档」当谷时价；能省多少 = 待充度数 × (现价 − 谷价)
 */
export async function chargeAdvice(D1, vin, sample, geos = null) {
  const battery = num(sample?.battery, null);
  if (battery === null || battery > 30) return null;
  if (sample.charging) return null;
  let pos = sample.position || null;
  if (!pos) {
    const recent = await db.listRecentPositions(D1, vin, { limit: 1 });
    if (recent.length) pos = { lat: recent[0].lat, lon: recent[0].lon };
  }
  if (!pos) return null;
  const list = geos || await db.listGeofences(D1, vin);
  const home = list.find((g) => g.label === "家") || null;
  let atHome = false;
  if (home) {
    const d = haversineM(pos, { lat: home.lat, lon: home.lon });
    atHome = d <= Number(home.radius_m || 400) * 1.15;
  }
  if (!atHome) return null;

  const tiers = await db.listElecTiers(D1);
  if (!tiers.length) return null;
  const nowPrice = await db.elecTierPriceAt(D1, shanghaiNow());
  const cheapest = tiers.reduce((a, b) => (Number(b.price) < Number(a.price) ? b : a), tiers[0]);
  const valleyPrice = Number(cheapest.price);
  const inValley = nowPrice !== null && Math.abs(Number(nowPrice) - valleyPrice) < 0.02;
  if (inValley) return null;                       // 已经是谷时，不用提醒

  const up = await db.getState(D1, "usage:price", null);
  const kwhPerPct = num(up?.kwh_per_pct, DEFAULT_KWH_PER_PCT) || DEFAULT_KWH_PER_PCT;
  const target = 80;                                // 建议充到 80%（增程车日常够用，也不伤电池）
  const needKwh = battery < target ? round((target - battery) * kwhPerPct, 1) : null;
  const saveCny = needKwh !== null && nowPrice !== null ? round(needKwh * (Number(nowPrice) - valleyPrice), 2) : null;
  return {
    battery, rangeKm: num(sample.range_km, null),
    //  分时段电价表（D-177 用户要求：结论不写建议，把整张表放进「电价表」折叠）
    tiers: tiers.map((t) => ({ from: t.from, to: t.to, price: Number(t.price), label: t.label })),
    nowPrice: nowPrice !== null ? Number(nowPrice) : null,
    valleyPrice,
    valleyWindow: cheapest.from && cheapest.to ? `${cheapest.from}~${cheapest.to}` : "谷时段",
    needKwh, saveCny: saveCny !== null && saveCny > 0 ? saveCny : null, inValley: false,
  };
}

async function handleChargeAdvice(env, D1, vehicle, sample, results, log) {
  const a = await chargeAdvice(D1, vehicle.vin, sample);
  if (!a) return;
  const target = await pushTarget(D1, "advice");
  if (!target) return;
  const today = shanghaiDate();
  const key = `advice:charge:${vehicle.vin}:${today}`;
  if (!(await db.markPushed(D1, vehicle.vin, key, "feishu", { battery: a.battery, save: a.saveCny }))) return;
  const card = cards.buildChargeAdviceCard({
    ...a, vehicle, at: sample.sampled_at,
    nowHHMM: (sample.sampled_at || shanghaiNow()).slice(11, 16),
    icons: await db.getState(D1, "card:icons", null),
  });
  const res = await sendCard(env, target, card);
  results.reminders = results.reminders || [];
  results.reminders.push({ key, ok: res.ok });
  log("充电建议 →", `电量 ${a.battery}%`, `谷时 ${a.valleyWindow} ${a.valleyPrice} 元/度`, res.ok ? "已发送" : `失败 ${res.msg || ""}`);
}

/** 某区间的加油汇总（D-093）：月报/指令共用，失败返回 null */
export async function fuelSummary(D1, vin, from, to) {
  try {
    const logs = await db.listFuelLogs(D1, vin, `${from} 00:00:00`, `${to} 23:59:59`);
    if (!logs.length) return null;
    return {
      times: logs.length,
      liters: Math.round(logs.reduce((a, r) => a + Number(r.liters || 0), 0) * 10) / 10,
      cost: Math.round(logs.reduce((a, r) => a + Number(r.cost_cny || 0), 0) * 100) / 100,
    };
  } catch { return null; }
}

// ── 泊车照片（D-092/D-093）：VSS filekey → 签名 URL → 5 张图 → 飞书 ──
async function handleParkPhoto(env, D1, client, vehicle, sample, vss, results, log) {
  const vin = vehicle.vin;
  const raw = vss?.["Vehicle.360Svm.Park.Filekey"]?.value;
  const parsed = parseParkFilekey(raw);
  if (!parsed || !parsed.picTime) return;

  // 同一张照片只推一次（picTime 是车机拍照时刻）
  const last = await db.getState(D1, `park:last:${vin}`, null);
  if (last?.picTime === parsed.picTime) return;

  //  D-200：用 push_log 的唯一约束 (vin, event_key, channel) 做**原子认领**。
  //    原来「sendCard 在前、markPushed 在后」，两路并发都能发出卡片；cron 一分钟一次，
  //    只要一轮采集慢过一分钟就会重叠（实测同一次停车连收 3 张一样的卡）。
  const key = `park:${vin}:${parsed.picTime}`;
  if (!(await db.markPushed(D1, vin, key, "feishu", { stage: "claim" }))) {
    log("泊车卡已认领（并发/重复），跳过");
    return;
  }

  const target = await pushTarget(D1, "park");
  if (!target) return;

  const fileKeys = PARK_ANGLES.map(([k]) => parsed.fileKeys[k]).filter(Boolean);
  if (!fileKeys.length) return;

  let urls = {};
  try {
    urls = await parkSignedUrls(client, fileKeys);
  } catch (err) {
    results.errors.push(`park: ${err.message}`);
    return;
  }

  const images = [];
  for (const [key, label] of PARK_ANGLES) {
    const fk = parsed.fileKeys[key];
    const url = fk ? urls[fk] : null;
    if (!url) continue;
    try {
      const bytes = await downloadImage(url);
      const imgKey = await uploadImage(env, bytes, "image/jpeg", `${key}.jpg`);
      if (imgKey) images.push({ label, imgKey });
    } catch (err) {
      log(`泊车照片 ${label} 失败: ${err.message}`);
    }
  }

  // 地点：优先围栏名（家/公司）→ 逆地理地址 → 降精度坐标（兜底）
  //  D-200：以前这里只调 locLabel，围栏外一律显示「30.00, 120.00」这种人看不懂的坐标。
  let place = null;
  let inFence = false;
  let distHome = null;
  try {
    const geos = await db.listGeofences(D1, vin);
    if (sample?.position) {
      const pos = sample.position;
      inFence = geos.some((g) => haversine(pos.lat, pos.lon, g.lat, g.lon) <= (num(g.radius_m, 500) || 500) * 1.15);
      place = locLabel(pos, geos);
      if (!inFence) {
        try {
          const g = await regeo(env, pos);
          if (g && g.address) place = compactPlace(g.address) || shortPlace(g.address);
        } catch (err) {
          log(`泊车地址逆地理失败，退回坐标: ${err.message}`);
        }
      }
      const home = geos.find((g) => g.label === "家");
      if (home) distHome = Math.round(haversine(pos.lat, pos.lon, home.lat, home.lon));
    }
  } catch { /* ignore */ }

  const icons = await db.getState(D1, "card:icons", null);
  const detail = await db.getState(D1, "last:detail", null);
  const pending = await db.getState(D1, `home:pending:${vin}`, null);
  const pendingAt = pending?.at ? parseShanghai(pending.at)?.getTime() || 0 : 0;
  const pendingFresh = pendingAt ? Date.now() - pendingAt <= HOME_PHOTO_WAIT_MS : false;

  try {
    await db.setState(D1, `park:last:${vin}`, { picTime: parsed.picTime, at: shanghaiNow(), images: images.length, keys: images });
    if (pending && pendingFresh) {
      // 到家卡还在等照片 → 带图一起发，不再单独发泊车卡（用户 m02764）
      await db.setState(D1, `home:pending:${vin}`, null);
      const res = await sendCard(env, target, cards.buildStopCard({
        kind: "home", at: pending.at, battery: pending.battery, range: pending.range, label: pending.label,
        sentinelText: pending.sentinel, locked: pending.locked,
        distanceM: pending.distanceM, images, vehicle, icons,
      }));
      await db.markPushed(D1, vin, key, "feishu", { images: images.length, merged: "home" });
      results.pushed.push({ key: pending.key, ok: res.ok, note: `到家卡含 ${images.length} 张照片` });
      log(`到家卡已合并 ${images.length} 张照片`);
    } else if (inFence) {
      // 已在围栏内停下（到家卡已推过，或照片来晚了）→ 不单发（来了也不补）
      await db.markPushed(D1, vin, key, "feishu", { images: images.length, merged: "none" });
      results.pushed.push({ key, ok: true, note: "围栏内不单发" });
      log("围栏内停车 → 不再单发泊车卡");
    } else {
      if (!target) throw new Error("未绑定飞书目标");
      const res = await sendCard(env, target, cards.buildStopCard({
        kind: "parked", at: parsed.picTime || sample?.sampled_at,
        battery: sample?.battery, range: sample?.range_km,
        sentinelText: detail?.sentinel_text ?? null, locked: detail?.locked ?? null,
        place, distanceM: distHome, images, vehicle, icons,
      }));
      await db.markPushed(D1, vin, key, "feishu", { images: images.length });
      results.pushed.push({ key, ok: res.ok });
      log(`车辆已停好已推送（${images.length}/${fileKeys.length} 张）`);
    }
  } catch (err) {
    results.errors.push(`park: ${err.message}`);
  }
}

/**
 * 能量提醒（D-173）：低电量 / 低油量，从「车辆异常」里拆出来单独成卡。
 *
 * 为什么要避让「充电建议」：充电建议在「在家 + 非谷时 + 电量 ≤30%」时就会推，
 * 它本身已经带电量数字与省钱结论；此时再推一张「电量偏低」纯属重复。
 * 所以这里先算一次 chargeAdvice()：它会触发就跳过电量项，只报油量。
 * 不在家 / 谷时 → 充电建议不会推 → 电量项由这张卡负责。
 */
async function handleEnergyLow(env, D1, vehicle, sample, results, log) {
  const items = [];
  const fuel = num(sample.fuel_level);
  if (fuel !== null && fuel <= ANOMALY.fuelLowPct) {
    items.push({
      label: "油量偏低",
      short: `${intOrDash(fuel)}% · 续航 ${intOrDash(sample.range_fuel)} km`,
      value: `${intOrDash(fuel)}% · 综合续航 ${intOrDash(sample.range_fuel)} km（阈值 ${ANOMALY.fuelLowPct}%）`,
      pct: fuel, rangeKm: num(sample.range_fuel),
    });
  }
  const batt = num(sample.battery);
  if (batt !== null && batt <= ANOMALY.batteryLowPct && !sample.charging) {
    let adviceWillPush = false;
    try { adviceWillPush = Boolean(await chargeAdvice(D1, vehicle.vin, sample)); } catch { adviceWillPush = false; }
    if (!adviceWillPush) {
      items.push({
        label: "电量偏低",
        short: `${intOrDash(batt)}% · 续航 ${intOrDash(sample.range_km)} km`,
        value: `${intOrDash(batt)}% · 纯电续航 ${intOrDash(sample.range_km)} km（阈值 ${ANOMALY.batteryLowPct}%）`,
        pct: batt, rangeKm: num(sample.range_km),
      });
    } else {
      log("电量偏低但充电建议会推，跳过电量项（避免重复）");
    }
  }
  if (!items.length) return [];

  const target = await pushTarget(D1, "energy");
  if (!target) {
    log("检出能量偏低但未绑定推送目标（或该类推送已关闭）:", items.map((i) => i.label).join(","));
    return [];
  }
  const day = sample.sampled_at.slice(0, 10);
  const key = `energy:${vehicle.vin}:${items.map((i) => i.label).join("+")}:${day}`;
  if (!(await db.markPushed(D1, vehicle.vin, key, "feishu", { items: items.map((i) => i.label) }))) return [];

  //  上次充电 / 上次加油时间：给用户「多久没补能了」的参考（D-173 追加）
  let lastChargeAt = null;
  let lastFuelAt = null;
  try {
    const cs = await db.listChargeSessions(D1, vehicle.vin, 1);
    lastChargeAt = cs[0] ? cs[0].ended_at || cs[0].started_at : null;
    const fl = await db.lastFuelLog(D1, vehicle.vin);
    lastFuelAt = fl ? fl.ended_at || fl.started_at : null;
  } catch (err) {
    log("能量卡取上次充电/加油时间失败:", err.message);
  }
  const res = await sendCard(env, target, cards.buildEnergyCard({
    items, at: sample.sampled_at, lastChargeAt, lastFuelAt,
    vehicle: await db.getVehicle(D1),
    icons: await db.getState(D1, "card:icons", null),
  }));
  results.pushed.push({ key, ok: res.ok });
  log(`能量提醒 → ${items.map((i) => i.label).join(",")}`, res.ok ? "已推送" : `失败 ${res.msg || ""}`);
  return items.map((i) => i.label);
}

async function handleAnomalies(env, D1, vehicle, sample, vss, results, log) {
  const vin = vehicle.vin;
  const kinds = [];
  const items = [];
  //  short 是给卡片正文用的短值（左对齐一行放得下），value 是完整说明（进折叠，对售后时报）
  const add = (kind, label, value, short = null) => {
    if (!kinds.includes(kind)) kinds.push(kind);
    items.push({ label, value, short });
  };

  // ① 胎压：车机告警优先，其次逐轮阈值，最后看四轮压差
  const tires = [
    ["左前", num(pick(vss, F.tire_fl_press))],
    ["右前", num(pick(vss, F.tire_fr_press))],
    ["左后", num(pick(vss, F.tire_rl_press))],
    ["右后", num(pick(vss, F.tire_rr_press))],
  ];
  const valid = tires.filter(([, v]) => v !== null && v > 0);
  if (valid.length >= 2) {
    const detail = tires.map(([k, v]) => `${k} ${kpa(v)}`).join(" / ");
    const vals = valid.map(([, v]) => v);
    const spread = Math.max(...vals) - Math.min(...vals);
    const low = valid.filter(([, v]) => v < ANOMALY.tireLowKpa).map(([k, v]) => `${k} ${kpa(v)}`);
    const high = valid.filter(([, v]) => v > ANOMALY.tireHighKpa).map(([k, v]) => `${k} ${kpa(v)}`);
    const warn = num(pick(vss, F.tire_warning));
    if (warn && warn !== 0) {
      add("tire", "胎压告警", `车机上报 TireWarning=${warn}`, `TireWarning=${warn}`);
    } else if (low.length) {
      add("tire", "胎压偏低", `${low.join("、")} kPa（标准 2.1~2.5 bar）`, `${low.join("、")} kPa`);
    } else if (high.length) {
      add("tire", "胎压偏高", `${high.join("、")} kPa（正常 2.1~2.5 bar）`, `${high.join("、")} kPa`);
    } else if (spread >= ANOMALY.tireSpreadKpa) {
      add("tire", "四轮压差偏大", `最大压差 ${Math.round(spread)} kPa（${detail}，慢漏气特征）`, `最大压差 ${Math.round(spread)} kPa`);
    }
  }

  // ②③ 电量/油量偏低不再算「车辆异常」，改由 handleEnergyLow 单独推「能量提醒」（D-173）

  // ④ 已插枪但没功率 —— 最常见的「以为在充，其实没充」
  //    预约充电期间没功率是正常的，所以要排除（reserve_start/end 有值即视为预约中）
  const plugged = isPlugged(vss);
  const power = (num(pick(vss, F.charge_power_cltc)) ?? 0) + (num(pick(vss, F.charge_power_wltc)) ?? 0);
  const reserveRaw = pick(vss, F.reserve_start);
  const reserving = reserveRaw !== null && String(reserveRaw).trim() !== "" && String(reserveRaw).trim() !== "0";
  const pkey = `plug:${vin}`;
  const ps = (await db.getState(D1, pkey, null)) || {};
  if (plugged && power <= 0 && !reserving) {
    if (!ps.since) {
      await db.setState(D1, pkey, { since: sample.sampled_at });
    } else {
      const waited = shanghaiDiffMs(sample.sampled_at, ps.since);
      if (waited !== null && waited >= ANOMALY.plugWaitMin * 60_000) {
        add("plug", "插枪未充电", `已插枪 ${Math.round(waited / 60_000)} 分钟仍无功率（非预约充电）`, `插枪 ${Math.round(waited / 60_000)} 分钟无功率`);
      }
    }
  } else if (ps.since) {
    await db.setState(D1, pkey, { since: null });
  }

  results.anomalies = kinds;
  if (!kinds.length) return kinds;

  const target = await pushTarget(D1, "anomaly");
  if (!target) {
    log("检出异常但未绑定飞书推送目标（或该类推送已关闭）:", kinds.join(","));
    return kinds;
  }
  // 同类每天最多一条：条件持续存在 → 次日才会再报一次（避免每分钟轰炸）
  const day = sample.sampled_at.slice(0, 10);
  const eventKey = `anom:${vin}:${kinds.slice().sort().join("+")}:${day}`;
  if (!(await db.markPushed(D1, vin, eventKey, "feishu", { kinds }))) return kinds;

  //  D-173：改用专属卡（短值一行 + 折叠完整说明），不再用通用 alert 模板
  const res = await sendCard(env, target, cards.buildAnomalyCard({
    items, at: sample.sampled_at,
    vehicle: await db.getVehicle(D1),
    icons: await db.getState(D1, "card:icons", null),
  }));
  results.pushed.push({ key: eventKey, ok: res.ok });
  log(`异常提醒 → ${kinds.join(",")}`, res.ok ? "已推送" : `失败 ${res.msg || ""}`);
  return kinds;
}

// ── 测试导出（D-064 回归用；生产代码不引用）──
export const __test = {
  fuelSummary,
  nextPollPlan, detectChange, POLL, handleParkPhoto,
  attachTripImage,
  repriceHistory,
  usagePrice,
  refreshUsagePrice,
  handleChargeTransition,
  handleTrip,
  handleGeofence,
  handleFuelTransition,
  handleAnomalies,
  handleEnergyLow,
  handleChargeAdvice,
  chargeAdvice,
  locLabel,
  reconcileChargeSessions,
  pushMissingChargeReceipts,
  fetchChargeSessions,
  dailyTask,
  checkCredentialHealth,
  buildTripRoute,
  backfillTrips,
  buildTripCardForPush,
};

