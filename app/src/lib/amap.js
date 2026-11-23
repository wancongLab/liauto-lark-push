/**
 * 高德 Web 服务封装（Worker 侧调用）
 *
 * 只用三个接口（D-073 实测可用）：
 *   - 驾车路径规划 `v3/direction/driving`：**当前用它重建线路形状**（两点 → 道路上的真实折线）
 *   - 轨迹纠偏 `v4/grasproad/driving`：实测**不可靠**（下面第 3 条），保留代码但默认不用
 *   - 逆地理 `v3/geocode/regeo`：起终点的门牌/小区名
 *
 *  两个实测结论（D-075/D-076），别踩：
 *   1. **静态地图画不了折线**（D-076 实测）：`paths=` 连高德官方示例都返回 `20003 UNKNOWN_ERROR`（两把 key 都一样）；
 *      `markers=` 单组最多 **30 个**坐标，且渲染出来是一串「蓝色图钉」而不是线 —— 不能当线路图用。
 *      ⇒ 线路图只在**面板**用 JS API 画真折线（方案 ③），飞书卡片放链接 + 文字摘要。
 *   2. **轨迹纠偏对 1 分钟采样不靠谱**（D-076 实测）：把 17:33→18:09 的 37 个真实点（真实 5km 行程）
 *      喂进去，返回的 53 个点只覆盖**终点附近约 1km**、经度跨度仅 60m，而 `distance` 却报 5169m ——
 *      前后矛盾，不能用来画整条线路。⇒ 改用「分段驾车路径规划」（`drivingRoute`）重建形状。
 *   3. 车报坐标是 **WGS-84**，调高德前必须 `wgs2gcj()`；返回的坐标都是 GCJ-02，存库/上图都用 GCJ。
 *
 * 配额（个人认证）：静态地图 5000/日、周边搜索 100/日、驾车路径规划 5000/日。本模块**不调周边搜索**。
 */
import { wgs2gcj } from "./geo.js";

const BASE = "https://restapi.amap.com";

export class AmapError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = "AmapError";
    Object.assign(this, extra);
  }
}

export function hasKey(env) {
  return Boolean(env && env.AMAP_KEY);
}

export async function amapGet(env, path, params) {
  if (!hasKey(env)) throw new AmapError("缺少 AMAP_KEY");
  const qs = new URLSearchParams({ ...params, key: env.AMAP_KEY }).toString();
  const res = await fetch(`${BASE}${path}?${qs}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new AmapError(`HTTP ${res.status}`, { http: res.status });
  const j = await res.json().catch(() => null);
  if (!j) throw new AmapError("响应不是 JSON");
  if (String(j.status) !== "1") {
    throw new AmapError(`高德返回失败: ${j.info} (${j.infocode})`, {
      infocode: j.infocode,
      info: j.info,
    });
  }
  return j;
}

/** 逆地理：返回中文地址（车报 WGS-84 坐标传入，内部转 GCJ） */
export async function regeo(env, point) {
  const g = wgs2gcj(Number(point.lat), Number(point.lon));
  const j = await amapGet(env, "/v3/geocode/regeo", {
    location: `${g.lon.toFixed(6)},${g.lat.toFixed(6)}`,
  });
  const c = j.regeocode?.addressComponent || {};
  const parts = [c.township || c.district, c.streetNumber?.street || c.street, c.streetNumber?.number]
    .filter((x) => typeof x === "string" && x.trim() && x !== "[]");
  return {
    address: j.regeocode?.formatted_address || parts.join("") || null,
    poi: c.township || null,
    gcj: g,
  };
}

/**
 * 驾车路径规划：两点之间真实道路的折线（GCJ-02）。
 * 这是目前**唯一可靠**的线路形状来源（D-076）：实测 5km 两个端点 → 8.9km 道路折线 131 点。
 */
export async function drivingRoute(env, from, to) {
  if (!hasKey(env)) throw new AmapError("缺少 AMAP_KEY");
  const a = wgs2gcj(Number(from.lat), Number(from.lon));
  const b = wgs2gcj(Number(to.lat), Number(to.lon));
  const j = await amapGet(env, "/v3/direction/driving", {
    origin: `${a.lon.toFixed(6)},${a.lat.toFixed(6)}`,
    destination: `${b.lon.toFixed(6)},${b.lat.toFixed(6)}`,
    extensions: "base",
  });
  const path = j.route?.paths?.[0];
  if (!path || !Array.isArray(path.steps)) throw new AmapError("路径规划没有返回路线");
  const points = [];
  for (const st of path.steps) {
    for (const pair of String(st.polyline || "").split(";")) {
      const [lon, lat] = pair.split(",").map(Number);
      if (Number.isFinite(lon) && Number.isFinite(lat)) {
        const prev = points[points.length - 1];
        if (!prev || prev.lon !== lon || prev.lat !== lat) points.push({ lat, lon });
      }
    }
  }
  return { points, distance_m: Number(path.distance) || null, duration_s: Number(path.duration) || null };
}

/**
 * 轨迹纠偏：输入**真实**行驶序列（WGS-84），返回贴合道路的点列（GCJ-02）。
 * 失败（引擎拒绝/点数不足）返回 null —— 调用方必须能降级（D-073 原则：图失败不能影响卡片）。
 */
export async function graspRoad(env, points) {
  if (!hasKey(env)) return null;
  const src = (points || []).filter((p) => Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon)));
  if (src.length < 3) return null;

  const body = src.slice(0, 500).map((p) => {
    const g = wgs2gcj(Number(p.lat), Number(p.lon));
    return {
      x: Number(g.lon.toFixed(6)),
      y: Number(g.lat.toFixed(6)),
      ag: 0,
      tm: Math.floor((p.ts || Date.now()) / 1000),
      sp: Math.max(0, Math.round(Number(p.speed ?? 30))),
    };
  });

  const res = await fetch(`${BASE}/v4/grasproad/driving?key=${env.AMAP_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const j = await res.json().catch(() => null);
  const d = j?.data ?? j;
  if (!d || (d.errcode && String(d.errcode) !== "0")) {
    throw new AmapError(`轨迹纠偏失败: ${d?.errmsg || "unknown"} (${d?.errcode})`, {
      errcode: d?.errcode,
    });
  }
  const out = Array.isArray(d.points) ? d.points : [];
  const pts = out
    .map((p) => ({ lat: Number(p.y), lon: Number(p.x) }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  return {
    points: pts,
    distance_m: Number(d.distance) || null,
  };
}

export const __test = {};
