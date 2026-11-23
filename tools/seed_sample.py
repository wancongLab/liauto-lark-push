#!/usr/bin/env python3
"""
生成示例历史数据 SQL（`app/scripts/seed-sample.sql`）。

为什么需要它：`seed.sql` 只建了车 + 电价 + 围栏，**没有历史**。所以刚 clone 下来跑，
  周报 / 月报 / 充电账单 / 行车流水 / 行程小结这几张卡全是「没有数据」——
  看不到东西，也就谈不上「读懂这个项目做了什么」。

这个脚本生成 45 天的确定性历史：每天一条 daily_stat、14 条 trip_log、8 次充电会话。
  数字全部编造，和任何真实车辆无关；同一个日期永远生成同一份数据（不用随机数）。

用法：
    python3 tools/seed_sample.py                     # 生成 app/scripts/seed-sample.sql
    cd app && npx wrangler d1 execute liauto-lark-push --local --file=scripts/seed-sample.sql
"""
import datetime as dt
import hashlib
import os

VIN = "LTEST000000000001"
DAYS = 45
TRIPS = 14
CHARGES = 8
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "app/scripts/seed-sample.sql")


def seed_of(s: str) -> int:
    """把日期串变成稳定的整数种子（不用 random，保证可复现）。"""
    return int(hashlib.sha256(s.encode()).hexdigest()[:8], 16)


def daily_rows(today: dt.date) -> list[str]:
    rows = []
    for i in range(DAYS, 0, -1):
        d = today - dt.timedelta(days=i)
        s = seed_of(d.isoformat())
        km = 12 + s % 51                       # 12 ~ 62 km/天
        elec = round(km * (0.60 + (s % 30) / 100), 1)
        hybrid = round(km - elec, 1)
        elec_kwh = round(elec * 0.152, 2)
        fuel_l = round(hybrid * 0.075, 2)
        ad = round(km * (0.16 + (s % 12) / 100), 1)
        noa = round(ad * 0.62, 1)
        charge_kwh = 0.0
        charge_times = 0
        if i % 3 == 0:                          # 每三天充一次
            charge_kwh = round(22 + (s % 16), 1)
            charge_times = 1
        cost = round(charge_kwh * 0.62, 2)
        fuel_cost = round(fuel_l * 7.85, 2)
        rows.append(
            "  ('{vin}', '{d}', {km}, {elec}, {hybrid}, {kwh}, {fuel}, 15.2, 7.5, "
            "{ad}, {noa}, {ckwh}, {ct}, {cost}, {fcost}, 'travel', '{d} 23:59:00')".format(
                vin=VIN, d=d.isoformat(), km=km, elec=elec, hybrid=hybrid, kwh=elec_kwh,
                fuel=fuel_l, ad=ad, noa=noa, ckwh=charge_kwh, ct=charge_times,
                cost=cost, fcost=fuel_cost))
    return rows


def trip_rows(today: dt.date) -> list[str]:
    rows = []
    for i in range(TRIPS, 0, -1):
        d = today - dt.timedelta(days=i % 20)
        s = seed_of(d.isoformat() + f"-{i}")
        start_h, start_m = 7 + (s % 3), s % 60
        dist = round(2.5 + (s % 380) / 10, 1)   # 2.5 ~ 40 km
        dur = int(dist / (0.5 + (s % 4) / 10))
        ended = (dt.datetime.combine(d, dt.time(start_h, start_m))
                 + dt.timedelta(minutes=dur))
        bat_from = 40 + (s % 50)
        bat_to = max(12, bat_from - int(dist / 4))
        start_loc = ["家", "公司", "30.00,120.00"][s % 3]
        end_loc = ["公司", "家", "30.02,120.03"][s % 3]
        ad = round(dist * (0.2 + (s % 20) / 100), 1)
        rows.append(
            "  ('{vin}', '{d} {sh:02d}:{sm:02d}:00', '{e}', {dist}, {dur}, {elec}, {eng}, {ad}, "
            "{b0}, {b1}, '{sl}', '{el}', 30.0, 120.0, 30.02, 120.03, NULL, NULL, NULL, NULL, '{d} {sh:02d}:{sm:02d}:00')".format(
                vin=VIN, d=d.isoformat(), sh=start_h, sm=start_m,
                e=ended.strftime("%Y-%m-%d %H:%M:%S"), dist=dist, dur=dur,
                elec=round(dist * 0.8, 1), eng=round(dist * 0.2, 1), ad=ad,
                b0=bat_from, b1=bat_to, sl=start_loc, el=end_loc))
    return rows


def charge_rows(today: dt.date) -> list[str]:
    rows = []
    for i in range(CHARGES, 0, -1):
        d = today - dt.timedelta(days=i * 3)
        s = seed_of(d.isoformat() + "-charge")
        start_h = 21 + (s % 3)
        kwh = round(20 + (s % 22), 1)
        dur = int(kwh / 0.42)                   # ≈25 kW 交流/直流混合
        ended = dt.datetime.combine(d, dt.time(start_h, s % 60)) + dt.timedelta(minutes=dur)
        price = round(0.5 + (s % 30) / 100, 2)
        rows.append(
            "  ('{vin}', '{d} {sh:02d}:{sm:02d}:00-1', '{d} {sh:02d}:{sm:02d}:00', '{e}', {dur}, {kwh}, 1, "
            "{p}, {cost}, {price}, '示例充电站', 1, '{d} {sh:02d}:{sm:02d}:00')".format(
                vin=VIN, d=d.isoformat(), sh=start_h, sm=s % 60,
                e=ended.strftime("%Y-%m-%d %H:%M:%S"), dur=dur, kwh=kwh,
                p=round(kwh / (dur / 60), 1), cost=round(kwh * price, 2), price=price))
    return rows


def main():
    today = dt.date.today()
    parts = [
        "-- 示例历史数据（由 tools/seed_sample.py 生成，不要手改）",
        "-- 45 天 daily_stat + 14 条行程 + 8 次充电，全部编造，与任何真实车辆无关。",
        f"-- 生成时间基准：{today.isoformat()}",
        "",
        "DELETE FROM daily_stat WHERE vin = '%s';" % VIN,
        "DELETE FROM trip_log WHERE vin = '%s';" % VIN,
        "DELETE FROM charge_session WHERE vin = '%s';" % VIN,
        "",
        "INSERT INTO daily_stat",
        "  (vin, stat_date, travel_km, elec_km, hybrid_km, elec_kwh, fuel_l,",
        "   avg_elec_kwh_per_100km, avg_fuel_l_per_100km, ad_km, noa_km,",
        "   charge_kwh, charge_times, cost_cny, fuel_cost_cny, source, updated_at)",
        "VALUES",
        ",\n".join(daily_rows(today)) + ";",
        "",
        "INSERT INTO trip_log",
        "  (vin, started_at, ended_at, distance_km, duration_min, elec_km, engine_km, ad_km,",
        "   battery_from, battery_to, start_loc, end_loc, start_lat, start_lon, end_lat, end_lon,",
        "   route_points, route_km, route_source, route_error, created_at)",
        "VALUES",
        ",\n".join(trip_rows(today)) + ";",
        "",
        "INSERT INTO charge_session",
        "  (vin, session_key, started_at, ended_at, duration_min, capacity_kwh, charging_type,",
        "   avg_power_kw, cost_cny, price_per_kwh, station_name, confirmed, created_at)",
        "VALUES",
        ",\n".join(charge_rows(today)) + ";",
        "",
    ]
    open(OUT, "w", encoding="utf-8").write("\n".join(parts))
    print(f"已生成 {OUT}（{DAYS} 天日汇总 / {TRIPS} 条行程 / {CHARGES} 次充电）")


if __name__ == "__main__":
    main()
