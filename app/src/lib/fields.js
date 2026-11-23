/**
 * VSS 字段映射 —— **全部来自 2026-10-28 实测**（L6 Max 增程版，151 条 path）
 *
 *  之前的直觉命名（Vehicle.Powertrain.Battery.Soc / Vehicle.Odometer.TotalDistance …）
 *    在理想这边**根本不存在** —— 理想用的是自有命名（Vehicle.Powertrain.Battery.ResidueBattery 等）。
 *    本表是唯一可信来源。
 */

export const F = {
  soc:            "Vehicle.Powertrain.Battery.ResidueBattery",     // 电量 %
  range_cltc_elec: "Vehicle.Cabin.CLTC.PureElecEnduranceMileInd",  // CLTC 纯电续航 km
  range_cltc_fuel: "Vehicle.Cabin.CLTC.FuelEnduranceMileInd",      // CLTC 综合续航 km
  range_wltc_elec: "Vehicle.Cabin.WLTC.PureElecEnduranceMileInd",  // WLTC 纯电续航 km
  range_wltc_fuel: "Vehicle.Cabin.WLTC.FuelEnduranceMileInd",      // WLTC 综合续航 km
  speed:          "Vehicle.XCU.VehSpd",                            // 车速 km/h
  indoor_temp:    "Vehicle.Cabin.AC.FrtACIncarTemp",               // 车内温度 ℃
  fuel_level:     "Vehicle.MSG.MSG_FuelLevelPos",                  // 油量/液位 %
  fuel_warning:   "Vehicle.MSG.MSG_FuelLevelWrnng",                // 油量告警
  pack_voltage:   "Vehicle.Powertrain.Battery.MSG_RESSInterVolt",   // 电池包电压 V

  charge_status:  "Vehicle.Powertrain.Battery.ChargeStatus",        // 充电状态码
  charge_complete: "Vehicle.Powertrain.Battery.VehicleChrgComplete",
  charge_power_cltc: "Vehicle.Powertrain.Battery.CLTCChargePower",  // 充电功率 kW
  charge_power_wltc: "Vehicle.Powertrain.Battery.WLTCChargePower",
  charge_current_ac: "Vehicle.Powertrain.Battery.ACChargeCurrent",
  charge_voltage_ac: "Vehicle.Powertrain.Battery.ACChargeVoltage",
  charge_limit:   "Vehicle.Powertrain.ChargingPile.ChargingLimit", // 充电上限 %
  charge_port_lid: "Vehicle.Body.DoorSwitchStatus.ChrgPorLidSts",   // 充电口盖
  battery_insulation: "Vehicle.Powertrain.ChargingPile.BatteryInsulation",
  reserve_start:  "Vehicle.Powertrain.ChargingPile.ScheduledCharging.ReserveStartTime",
  reserve_end:    "Vehicle.Powertrain.ChargingPile.ScheduledCharging.NewReserveFinishTime",

  travel_status:  "Vehicle.Cabin.TravelStatus",                    // 行驶状态
  trip_total:     "Vehicle.Carcenter.Trip.Total",                   // 车机行程表（36 字段）

  location:       "Vehicle.Location.CurrentLocationInfo",          // {lat,lon,alt,dir,hdop}
  svm_filekey:    "Vehicle.360Svm.Park.Filekey",                   // 泊车照片
  svm_state:      "Vehicle.360Svm.ParkPhoto.State",

  sentinel:       "Vehicle.Sentry.SentinelStatus",                  // {sentinelStatus,subStatus}
  sentinel_switch: "Vehicle.Sentry.SettingsStatus",                // {sentinelSwitch}
  sentinel_video: "Vehicle.Sentry.Video.Count",

  ota_state:      "Vehicle.OTA.Upgrade.UpgradeState",
  ota_progress:   "Vehicle.OTA.Upgrade.UpgradeProgress",
  ota_version:    "Vehicle.Version.OTA.Baseline",

  ac_set_temp:    "Vehicle.Cabin.AC.SetTemp",
  ac_wind_mode:   "Vehicle.Cabin.AC.WindMode",
  ac_defrost:     "Vehicle.Cabin.AC.DefrostModeStatus",
  ac_speed:       "Vehicle.Cabin.AC.ExSpeedStatus",
  fridge_mode:    "Vehicle.Cabin.Fridge.ModeState",
  fridge_temp:    "Vehicle.Cabin.Fridge.CoolTempSt",

  tire_fl_press:  "Vehicle.Chassis.Tire.FLTirePressure",
  tire_fr_press:  "Vehicle.Chassis.Tire.FRTirePressure",
  tire_rl_press:  "Vehicle.Chassis.Tire.RLTirePressure",
  tire_rr_press:  "Vehicle.Chassis.Tire.RRTirePressure",
  tire_fl_temp:   "Vehicle.Chassis.Tire.FLTireTemp",
  tire_fr_temp:   "Vehicle.Chassis.Tire.FRTireTemp",
  tire_rl_temp:   "Vehicle.Chassis.Tire.RLTireTemp",
  tire_rr_temp:   "Vehicle.Chassis.Tire.RRTireTemp",
  tire_warning:   "Vehicle.Chassis.Tire.TireWarning",
  tpms_status:    "Vehicle.Chassis.Tire.TPMSSysSts",

  door_main:      "Vehicle.Body.DoorSwitchStatus.MainDoor",
  door_copilot:   "Vehicle.Body.DoorSwitchStatus.CopilotDoor",
  door_back_left: "Vehicle.Body.DoorSwitchStatus.BackLeftDoor",
  door_back_right:"Vehicle.Body.DoorSwitchStatus.BackRightDoor",
  door_trunk:     "Vehicle.Body.DoorSwitchStatus.TrunkDoor",
  door_case:      "Vehicle.Body.DoorSwitchStatus.CaseCoverStatus",
  door_tank:      "Vehicle.Body.DoorSwitchStatus.TankLockDrvSts",
  lock_main:      "Vehicle.Body.DoorLockStatus.MainDoor",
  lock_copilot:   "Vehicle.Body.DoorLockStatus.CopilotDoor",
  lock_back_left: "Vehicle.Body.DoorLockStatus.BackLeftDoor",
  lock_back_right:"Vehicle.Body.DoorLockStatus.BackRightDoor",
  lock_trunk:     "Vehicle.Body.DoorLockStatus.TrunkDoor",
  lock_front_trunk:"Vehicle.Body.DoorLockStatus.FrontTrunkDoor",
  win_main:       "Vehicle.Body.WindowPosition.MainWindow",
  win_copilot:    "Vehicle.Body.WindowPosition.CopilotWindow",
  win_back_left:  "Vehicle.Body.WindowPosition.BackLeftWindow",
  win_back_right: "Vehicle.Body.WindowPosition.BackRightWindow",
  win_skylight:   "Vehicle.Body.WindowPosition.SkylightWindow",

  seat_drv_heat:  "Vehicle.Cabin.Seat.FLSeatHeatState",
  seat_pass_heat: "Vehicle.Cabin.Seat.FRSeatHeatState",
  mirror_l_heat:  "Vehicle.Body.RearMirro.LHeatSts",
  mirror_r_heat:  "Vehicle.Body.RearMirro.RHeatSts",
  sunshade_front: "Vehicle.Body.SunShade.FrontPos",
  sunshade_rear:  "Vehicle.Body.SunShade.RearPos",
  light_lic:      "Vehicle.Body.Light.LicLghtSts",
  air_pollution:  "Vehicle.Cabin.AirPollutionIndex",
};

/** 门/窗/锁状态语义：0=关/锁，1=开/解锁，2=半开/运动中 */
export function isOpen(v) {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0;
}

export function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 从 VSS 帧里取值 */
export function pick(vss, path) {
  const it = vss && vss[path];
  if (!it) return null;
  return it.value === undefined ? null : it.value;
}

/**
 * 取可能是「JSON 字符串」的 VSS 值（D-086 踩过三次：Maintain.* 六项的 value 是字符串）。
 * pick() 返回的是原始字符串，必须再 parse 才能读 maintainLeftMileage。
 */
export function pickJson(vss, path) {
  let v = pick(vss, path);
  if (typeof v === "string") {
    const t = v.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try { v = JSON.parse(t); } catch { return null; }
    }
  }
  return v && typeof v === "object" ? v : null;
}

/**
 * 充电状态码（实测确认的 ChargeStatus 映射表）
 *   0 / 15  未充电
 *   10      已插枪（未开始）
 *   30 / 70 充电中
 *   130     充电完成
 * VehicleChrgComplete: 0=未完成 1=已完成 2=未充电
 */
export const CHARGE_STATUS = {
  0: "未充电", 10: "已插枪", 15: "未充电",
  30: "充电中", 70: "充电中", 130: "充电完成",
};

/** 是否正在充电（状态码优先，其次功率/电流） */
export function isCharging(vss) {
  const st = num(pick(vss, F.charge_status));
  if (st === 30 || st === 70) return true;
  const p = num(pick(vss, F.charge_power_cltc)) ?? 0;
  const w = num(pick(vss, F.charge_power_wltc)) ?? 0;
  const iac = num(pick(vss, F.charge_current_ac)) ?? 0;
  return p > 0 || w > 0 || iac > 0;
}

/** 已插枪但未开始 */
export function isPlugged(vss) {
  const st = num(pick(vss, F.charge_status));
  return st === 10;
}

/** 充电状态码 → 中文 */
export function chargeStatusText(v) {
  const n = num(v);
  if (n === null) return "--";
  return CHARGE_STATUS[n] ?? `状态${n}`;
}

/** 行驶状态码 → 中文 */
export function travelStatusText(v) {
  const n = num(v);
  if (n === null) return "--";
  // D-106：车机该枚举 4 的语义是「车机休眠，无法判断是否在开」，厂商原文就是「离线/停车」，
  // 卡片上改成一句人话，避免用户以为出现了两个状态。
  return { 0: "已停车", 1: "启动中", 2: "行驶中", 3: "怠速", 4: "停车（车机休眠）" }[n] ?? `状态${n}`;
}

/**
 * 把 VSS 原始 map 折成卡片/接口用的 detail 对象。
 * 原来这个函数只写在 index.js 里，D-086 的飞书指令也要用 → 挪到这里共用，
 * 避免两处口径漂移（曾出现过 /api/status 与卡片字段不一致）。
 */
export function buildDetail(vss) {
  const v = vss || {};
  //  D-167：这两个值都是 JSON 字符串（{"sentinelStatus":3,"sentinelSubStatus":0} / {"sentinelSwitch":2}），
  //  用 pick() 拿到的是字符串 → 读 .sentinelStatus 永远 undefined → 卡片永远「关闭」。
  const sentinel = pickJson(v, F.sentinel);
  const sentinelSwitch = pickJson(v, F.sentinel_switch);
  const ota = pick(v, F.ota_state);
  const tires = {};
  for (const [k, p] of [["左前", F.tire_fl_press], ["右前", F.tire_fr_press], ["左后", F.tire_rl_press], ["右后", F.tire_rr_press]]) {
    const n = num(pick(v, p));
    if (n !== null) tires[k] = n;
  }
  //  D-167：锁车只看「有没有锁」。**语义是 0=已锁 / 1=解锁 / 2=运动中**（本文件 isOpen 注释、
  //  以及 2026-10-27 夜间实测「车停在家里 6 个门全是 0」都是这个口径）。
  //  D-141 曾写反（要求全部为 1），导致到家卡永远显示「未锁车」。
  //  前备箱（FrontTrunkDoor）剔除：实测恒为 1 且从 2026-11-15 起再没更新过，L6 前备箱也不可用，
  //  计入会把任何状态都判成未锁。
  const lockKeys = [F.lock_main, F.lock_copilot, F.lock_fl, F.lock_fr, F.lock_trunk].filter(Boolean);
  const lockVals = lockKeys.map((k) => pick(v, k)).filter((x) => x !== undefined && x !== null);
  const locked = lockVals.length >= 3 ? lockVals.every((x) => Number(x) === 0) : null;
  return {
    locked,
    range_elec: num(pick(v, F.range_cltc_elec)),
    range_fuel: num(pick(v, F.range_cltc_fuel)),
    range_wltc_elec: num(pick(v, F.range_wltc_elec)),
    range_wltc_fuel: num(pick(v, F.range_wltc_fuel)),
    fuel_level: num(pick(v, F.fuel_level)),
    pack_voltage: num(pick(v, F.pack_voltage)),
    charge_power: num(pick(v, F.charge_power_cltc)),
    charge_limit: num(pick(v, F.charge_limit)),
    charge_status_text: chargeStatusText(pick(v, F.charge_status)),
    travel_status_text: travelStatusText(pick(v, F.travel_status)),
    //  开关量以 SettingsStatus.sentinelSwitch 为准（实测：关闭=0，开着=2）；SentinelStatus 只在「正在录像」时才会动，
    //  单独用它会把「已布防但当前没录」误报成关闭（D-167）。
    sentinel_text: (() => {
      const sw = num(sentinelSwitch && sentinelSwitch.sentinelSwitch);
      const st = num(sentinel && sentinel.sentinelStatus);
      if (sw === null && st === null) return null;        // 两个都拿不到 → 不显示，别猜「关闭」
      const on = (sw !== null && sw > 0) || (st !== null && st > 0);
      return on ? "开启" : "关闭";
    })(),
    ota_version: (ota && ota.currentVersion) || (pick(v, F.ota_version)) || null,
    tires,
    ac_set_temp: num(pick(v, F.ac_set_temp)),
    // 保养六项（D-162）：值是 JSON 字符串，抽成 {left, period, byEngine} 存进 detail，
    // 否则指令「保养」只能读到空 payload（payload 从 D-093 起不再存整包 VSS）。
    maint: (() => {
      const out = {};
      const items = {
        enginelevel1: "Vehicle.Carcenter.Maintain.enginelevel1",
        enginelevel2: "Vehicle.Carcenter.Maintain.enginelevel2",
        acfilter: "Vehicle.Carcenter.Maintain.acfilter",
        sparkplug: "Vehicle.Carcenter.Maintain.sparkplug",
        coolfuild: "Vehicle.Carcenter.Maintain.coolfuild",
        gearbrakeoil: "Vehicle.Carcenter.Maintain.gearbrakeoil",
      };
      for (const [k, path] of Object.entries(items)) {
        const o = pickJson(v, path);
        if (!o) continue;
        const left = num(o.maintainLeftMileage, null);
        if (left === null) continue;
        const byEngine = String(o.mileageSource || "") === "engine";
        //  D-169：这一项里还有到期日(maintainDueDate)、上次保养时间(maintenanceTime, ms)
        //  与上次保养时的里程，用得上就一并带出去（保养卡「到期日期」与折叠里的上次保养）
        const dueRaw = String(o.maintainDueDate || "");
        const lastMs = num(o.maintenanceTime, null);
        out[k] = {
          left: Math.round(left),
          period: num(o.periodMileage, null),
          byEngine,
          name: o.name || null,
          due: /^\d{8}$/.test(dueRaw) ? dueRaw : null,
          lastAt: lastMs ? new Date(lastMs + 8 * 3600 * 1000).toISOString().slice(0, 10) : null,
          lastKm: num(byEngine ? o.maintenanceEngineMileage : o.maintenanceMileage, null),
        };
      }
      return out;
    })(),
    svm_filekey: pick(v, F.svm_filekey),
  };
}
