/**
 * 自定义数据源（`VEHICLE_PROVIDER=custom`）
 *
 * 这是**留给你实现的空壳**。接自己的车，通常要做三件事：
 *
 *   1. 认证：拿到一个能读实时信号的 access token（密码登录 / 扫码 / 官方开放平台 OAuth）。
 *      —— 这部分属于你与厂商之间的事，本仓库不含任何厂商的登录协议。
 *   2. 批量读：实现 `getVss(paths)`，把厂商的信号名映射到 `fields.js` 里那套 path。
 *      映射表就是这个仓库最值钱的东西之一，照着改即可。
 *   3. 直取接口：实现 `travel(path)` / `getChargeSessions()`，把日汇总、充电记录原样返回。
 *
 * 建议把凭据放 Worker secret（`wrangler secret put`）或 D1，不要写进代码。
 *
 * 实现完把 `wrangler.jsonc` 里的 `VEHICLE_PROVIDER` 改成 `"custom"` 即可。
 */

export class CustomVehicleClient {
  constructor(env, D1) {
    this.env = env;
    this.db = D1;
    this.provider = "custom";
    this.vin = env.VEHICLE_VIN || "";
  }

  credentialStatus() {
    // 返回 { level: "ok"|"warn"|"critical"|"dead", days_left, expires_at, expiry_source, warnings[] }
    return { level: "ok", days_left: null, expires_at: null, expiry_source: null, warnings: [] };
  }

  async getVss() {
    throw new Error("CustomVehicleClient.getVss 未实现：见 app/src/lib/vehicle/custom.js 顶部说明");
  }

  async travel() {
    throw new Error("CustomVehicleClient.travel 未实现");
  }

  async getChargeSessions() {
    throw new Error("CustomVehicleClient.getChargeSessions 未实现");
  }

  async getVehicles() {
    throw new Error("CustomVehicleClient.getVehicles 未实现");
  }

  async refresh() {
    return false;
  }
}
