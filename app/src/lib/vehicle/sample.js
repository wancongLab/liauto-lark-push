/**
 * 示例数据源（`VEHICLE_PROVIDER=sample`）
 *
 * 为什么要有它：这个仓库展示的是「拿到车的数据之后怎么用」，而**怎么拿到数据**属于
 * 各家自己的协议层（见 `docs/如何接入你自己的车辆数据.md`）。没有示例数据源的话，
 * 别人 clone 下来既跑不起来、也不知道每张卡的数据长什么样。
 *
 * 它做什么：把 `fields.js` 里那 151 条 VSS path 都填上**合理**的值，并让里程随时间缓慢增长
 * （每分钟约 0.35 km）——这样 `collect` 跑起来能真的产生采样、行程、日报，
 * 21 张卡都有数可看。值全部是编的，与任何真实车辆无关。
 *
 * 它不做什么：不联网、不登录、不需要任何凭据。
 */
import { F } from "../fields.js";
import { shanghaiNow } from "../util.js";

const SAMPLE_VIN = "LTEST000000000001";
const ORIGIN = { lat: 30.0, lon: 120.0 };     // 编的坐标（只用于围栏判断演示）
const BASE_ODO_KM = 18420;                    // 2026-01-01 当天的里程表读数
const EPOCH_DAY = Math.floor(Date.parse("2026-01-01T00:00:00+08:00") / 86400000);

/**
 * 「今天在开车吗」——示例轨迹是**两段通勤**，不是一直开。
 *
 *  为什么不按「每分钟涨一点」：那样里程一天涨 500 km，而且车永远在路上，
 *  既不会有「到家/离家」，行程也永远结束不了。两段通勤才能让 21 张卡都有真实触发条件。
 *  全按上海时区的「当天第几分钟」算，所以是确定性的：同一分钟内反复调用结果一致。
 */
const DRIVE_WINDOWS = [[480, 520], [1090, 1120]];   // 08:00–08:40、18:10–18:40
const KM_PER_MIN = 0.55;                            // ≈33 km/h 市区速度
const DAY_KM = DRIVE_WINDOWS.reduce((a, [s0, e0]) => a + (e0 - s0) * KM_PER_MIN, 0);

function minuteOfDay(now = Date.now()) {
  return Math.floor(((now + 8 * 3600 * 1000) % 86400000) / 60000);
}
function dayIndexOf(now = Date.now()) {
  return Math.floor((now + 8 * 3600 * 1000) / 86400000);
}
/** 当天到第 m 分钟为止开了多少公里（决定里程表，也和轨迹位置同源） */
function kmWithinDay(m = minuteOfDay()) {
  let km = 0;
  for (const [a, b] of DRIVE_WINDOWS) {
    if (m > a) km += (Math.min(m, b) - a) * KM_PER_MIN;
  }
  return km;
}
function isDriving(now = Date.now()) {
  const m = minuteOfDay(now);
  return DRIVE_WINDOWS.some(([a, b]) => m >= a && m < b);
}
function odoKm(now = Date.now()) {
  const days = dayIndexOf(now) - EPOCH_DAY;
  return BASE_ODO_KM + days * DAY_KM + kmWithinDay(minuteOfDay(now));
}
/** 通勤途中沿一条「出去再回来」的弧线走；停着的时候就在家 */
function locationAt(now = Date.now()) {
  const m = minuteOfDay(now);
  const win = DRIVE_WINDOWS.find(([a, b]) => m >= a && m < b);
  if (!win) return { lat: ORIGIN.lat, lon: ORIGIN.lon, alt: 30, dir: 0, hdop: 1 };
  const [a, b] = win;
  const t = (m - a) / (b - a);                       // 0 → 1
  const lat = ORIGIN.lat + 0.018 * Math.sin(t * Math.PI);
  const lon = ORIGIN.lon + 0.022 * Math.sin(t * Math.PI);
  return { lat: +lat.toFixed(6), lon: +lon.toFixed(6), alt: 30, dir: Math.round(t * 360), hdop: 1 };
}

/** 车机行程表（`Vehicle.Carcenter.Trip.Total`，36 个字段，单位是米） */
function tripTotal(now = Date.now()) {
  const km = odoKm(now);
  const m = (v) => Math.round(v * 1000);
  return {
    mileage: m(km),
    cdMileage: m(km * 0.78),
    engineMileage: m(km * 0.22),
    adMileage: m(km * 0.21),
    noaMileage: m(km * 0.14),
    lccMileage: m(km * 0.05),
    accMileage: m(km * 0.02),
    adMileageDate: 48,
    cityNoaDays: 41,
    cityNoaMileage: m(km * 0.11),
    highWayNoaDays: 12,
    highWayNoaMileage: m(km * 0.03),
  };
}

/** 静态/半静态值表：key 是 `fields.js` 里的字段名 */
const BY_FIELD = {
  soc: 62,
  range_cltc_elec: 182,
  range_cltc_fuel: 948,
  range_wltc_elec: 148,
  range_wltc_fuel: 771,
  speed: 0,
  indoor_temp: 21,
  fuel_level: 45,
  fuel_warning: 0,
  pack_voltage: 372.5,
  charge_status: 0,
  charge_complete: 0,
  charge_power_cltc: 0,
  charge_power_wltc: 0,
  charge_current_ac: 0,
  charge_voltage_ac: 0,
  charge_limit: 90,
  charge_port_lid: 0,
  battery_insulation: 0,
  travel_status: 0,
  ac_set_temp: 22,
  ac_wind_mode: 1,
  ac_defrost: 0,
  ac_speed: 0,
  fridge_mode: 0,
  fridge_temp: 8,
  //  胎压单位是 **kPa**（collector 用 <190 / >320 判异常，正常 210~250）
  tire_fl_press: 245,
  tire_fr_press: 243,
  tire_rl_press: 240,
  tire_rr_press: 242,
  tire_fl_temp: 24,
  tire_fr_temp: 24,
  tire_rl_temp: 23,
  tire_rr_temp: 23,
  ota_state: 0,
  ota_progress: 0,
  ota_version: "sample-1.0",
  svm_state: 0,
  svm_filekey: null,
};

/** JSON 形状的字段（`value` 是真对象，不是字符串） */
const BY_FIELD_JSON = {
  location: () => locationAt(),
  trip_total: () => tripTotal(),
  sentinel: () => ({ sentinelStatus: 0, subStatus: 0 }),
  sentinel_switch: () => ({ sentinelSwitch: 1 }),
  sentinel_video: () => ({ count: 0 }),
};

/** path → 字段名 反查表（F 里一个字段可能有多个候选 path） */
const FIELD_BY_PATH = (() => {
  const out = new Map();
  for (const [name, paths] of Object.entries(F)) {
    for (const p of Array.isArray(paths) ? paths : [paths]) {
      if (typeof p === "string") out.set(p, name);
    }
  }
  return out;
})();

/** 兜底：没在表里但确实是数值型的 path，给一个中性值而不是 null */
function fallbackValue(path) {
  if (/Temp$/.test(path)) return 22;
  if (/(Press|Pressure)$/.test(path)) return 240;   // kPa
  if (/(Status|State|Mode|Switch)$/.test(path)) return 0;
  return 0;
}

export class SampleVehicleClient {
  constructor(env = {}) {
    this.provider = "sample";
    this.vin = env.SAMPLE_VIN || SAMPLE_VIN;
    this.appType = "sample";
  }

  /** 示例数据源没有登录态，返回一个明确的 sample 状态（面板会显示「示例数据」） */
  credentialStatus() {
    return {
      level: "sample",
      days_left: null,
      expires_at: null,
      expiry_source: "sample",
      warnings: [],
    };
  }

  async getVehicles() {
    return [{
      vin: this.vin,
      nickname: "Cong's Li L6 Max",
      spu: "理想L6 Max",
      seriesNo: "X04",
      modelNo: "X46S",
      seatCount: 5,
      vehicleType: "owned",
      roleId: 11,
    }];
  }

  /** 批量实时信号：形状与真实实现一致 → `{ [path]: { value, ts } }` */
  async getVss(paths = []) {
    const ts = shanghaiNow();
    const out = {};
    for (const p of paths) {
      const name = FIELD_BY_PATH.get(p);
      if (name && BY_FIELD_JSON[name]) {
        out[p] = { value: BY_FIELD_JSON[name](), ts };
      } else if (name === "speed") {
        //  停着 0，通勤途中在 20~45 km/h 之间摆（按分钟确定性变化，不抖）
        out[p] = { value: isDriving() ? 20 + (minuteOfDay() % 26) : 0, ts };
      } else if (name === "travel_status") {
        out[p] = { value: isDriving() ? 2 : 0, ts };
      } else if (name && name in BY_FIELD) {
        out[p] = { value: BY_FIELD[name], ts };
      } else {
        out[p] = { value: fallbackValue(p), ts };
      }
    }
    return out;
  }

  /**
   * 直取接口（真实实现里是 travel / 充电记录这类 GET）。
   * 这里只合成「单日日汇总」，其余返回空列表——够让日报/周报/月报成立。
   */
  async travel(path) {
    const m = String(path).match(/travel\/daily\/aggregate\/[^?]*\?startDate=(\d{4}-\d{2}-\d{2})/);
    if (m) {
      const date = m[1];
      return { code: 0, data: dailyAggregate(date) };
    }
    return { code: 0, data: [] };
  }

  async getChargeSessions() {
    return { code: 0, data: [] };
  }

  async getChargeMonthlyStats() {
    return { code: 0, data: [] };
  }

  /** 示例数据源没有 refresh_token，续期永远返回 false */
  async refresh() {
    return false;
  }
}

/**
 * 按日期确定性生成「某一天」的行驶数据（同一天多次调用结果一致）。
 *
 * 用日期字符串做种子而不是随机数：读者今天跑、明天跑，看到的历史是一致的，
 * 不会出现「每次刷新数字都变」的错觉。
 */
function dailyAggregate(date) {
  const seed = [...date].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 9973, 7);
  const km = 18 + (seed % 45);                        // 18 ~ 62 km
  const elecRatio = 0.62 + ((seed % 23) / 100);        // 62% ~ 84% 纯电
  const elecKm = +(km * elecRatio).toFixed(1);
  const hybridKm = +(km - elecKm).toFixed(1);
  const elecEnergy = +(elecKm * 0.152).toFixed(2);     // 约 15.2 kWh/100km
  const fuel = +(hybridKm * 0.075).toFixed(2);         // 约 7.5 L/100km
  return {
    travelMileage: km,
    elecMileage: elecKm,
    hybridMileage: hybridKm,
    elecEnergy,
    fuelConsumption: fuel,
    avgElecEnergy: 15.2,
    avgFuelConsumption: 7.5,
  };
}

export { SAMPLE_VIN };
