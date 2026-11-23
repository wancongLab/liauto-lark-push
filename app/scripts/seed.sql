-- 一次性初始化：车辆信息 + 默认电价/油价
-- ★ 车辆信息来自 2026-10-28 的 Phase 0 实测（saos_vehicle 原始条目）。
--   之后 Worker 运行期【不再】调用该接口（见 D-048），此表是唯一来源。

INSERT OR REPLACE INTO vehicle
  (vin, spu, series_no, model_no, nickname, plate_no, seat_count,
   vehicle_type, role_id, energy_type, raw_json, updated_at)
VALUES (
  'LTEST000000000001',
  '理想L6 Max',
  'X04',
  'X46S',
  'Cong''s Li L6 Max',
  '赣A000002',
  5,
  'owned',
  11,
  'erev',
  '{"modelName":"理想L6","seriesName":"理想L6","spu":"理想L6 Max","seriesNo":"X04","modelNo":"X46S","seatCount":5,"vehicleType":"owned","vehicleRoleId":11,"variableModel":"AD MAX+无踏板+电池CATL+后驱汇川+万向后卡钳+天纳克减振器+西菱增压器+德赛XCU+中自催化剂+斯泰必鲁斯背门撑杆+有冰箱+铂金音响","wheelName":"21英寸精车轮毂","interiorName":"内饰风格-黑白（IX09&IA08）","mainPictureUrl":"https://p.ampmake.com/aisp/account/20240419/iam/vehicle_pos_pic/1713519571991_vehicle_pos_pic"}',
  '2026-10-28 00:00:00'
);

-- 默认电价（家充）与油价 —— **占位值，可随时改**
--   改法：POST /api/price {"electric":0.62,"fuel":7.85}
--   或直接改本文件后重跑 wrangler d1 execute
DELETE FROM price_rule WHERE scope IN ('default','fuel') AND effective_to IS NULL;
INSERT INTO price_rule (scope, price_cny, effective_from, source, note, created_at)
VALUES ('default', 0.62, '2026-10-01 00:00:00', 'seed', '默认家充电价（元/度）· 可通过 /api/price 修改', '2026-10-28 00:00:00'),
       ('fuel',    7.85, '2026-10-01 00:00:00', 'seed', '95号汽油价（元/L）· 可通过 /api/price 修改', '2026-10-28 00:00:00');

-- 地理围栏（到家 / 到公司）—— 换成你自己的真实坐标
--   下面两个示例坐标与 app/src/lib/vehicle/sample.js 的模拟位置对齐（30.000000, 120.000000），
--   所以示例模式下「到家」能立刻命中；实际使用时改经纬度、保持 enabled=1 即可。
INSERT OR REPLACE INTO geofence (vin, label, lat, lon, radius_m, dwell_sec, enabled, created_at)
VALUES ('LTEST000000000001', '家',  30.000000, 120.000000, 400, 300, 1, '2026-10-28 00:00:00'),
       ('LTEST000000000001', '公司', 30.020000, 120.030000, 400, 300, 1, '2026-10-28 00:00:00');
