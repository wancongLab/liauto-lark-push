/**
 * 车辆数据源（provider）入口
 *
 * 这个仓库刻意把「怎么拿到车的数据」和「拿到之后怎么用」切成两层：
 *
 *   ① 数据源层（本目录）—— 你实现 `VehicleClient` 这套方法，返回原始数值；
 *   ② 业务层（collector / cards / tripPage / 面板）—— 采什么、算成什么、卡片长什么样。
 *
 * 业务层只依赖下面这张「接口名片」，不认识任何具体厂商的登录协议：
 *
 *   client.vin                              // string
 *   client.provider                         // "sample" | "custom"
 *   client.credentialStatus()               // { level, days_left, expires_at, expiry_source, warnings[] }
 *   client.getVss(paths, opts)              // { [path]: { value, ts } }    批量读实时信号
 *   client.travel(path)                     // 原始 JSON（日汇总、充电记录这类直取接口）
 *   client.getChargeSessions(dt, type)      // 原始 JSON
 *   client.getVehicles()                    // 车辆列表（一次性，运行期不要再调）
 *   client.refresh()                        // 可选：续期，返回 boolean
 *
 * 切换方式：Worker 环境变量 `VEHICLE_PROVIDER`（默认 `sample`）。
 */
import { SampleVehicleClient } from "./sample.js";
import { CustomVehicleClient } from "./custom.js";

export const PROVIDERS = ["sample", "custom"];

export async function createVehicleClient(env, D1 = null) {
  const mode = String(env.VEHICLE_PROVIDER || "sample").toLowerCase();
  if (mode === "sample") return new SampleVehicleClient(env);
  if (mode === "custom") return new CustomVehicleClient(env, D1);
  throw new Error(`VEHICLE_PROVIDER 只能是 ${PROVIDERS.join(" / ")}，收到「${mode}」`);
}
