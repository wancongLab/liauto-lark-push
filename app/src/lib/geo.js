/**
 * 地理坐标工具（D-073）
 *
 *  为什么需要这个文件：
 *   理想车机上报的是 **WGS-84**（原始 GPS），而高德底图/geocode/POI 全是 **GCJ-02**（火星坐标）。
 *   两者在实测中系统性相差 **608 m**（见 D-073：原始点逆地理解出「示例小区甲」，
 *   转 GCJ-02 后解出「示例小区乙」）。
 *
 * 铁律：
 *   - 拿车的位置去**叠加高德底图 / 调高德接口**（静态地图、逆地理、POI、轨迹纠偏）→ 先 `wgs2gcj()`
 *   - 拿高德返回的坐标去**和车的位置比较**（围栏、距离、聚类）→ 先 `gcj2wgs()`，或者干脆别用高德坐标
 *     （D-073 的结论：围栏中心应该用「车自己的历史停车点」算，天然在 WGS-84 系里）
 *   - 只做**两点距离**（Haversine）时，两边坐标系必须一致；都在 WGS-84 里算最省心
 */

const A = 6378245.0;              // 克拉索夫斯基椭球长半轴
const EE = 0.00669342162296594323; // 偏心率平方
const R_EARTH = 6371000;          // 地球平均半径（米）

/** WGS-84 → GCJ-02（国境外的点原样返回，高德在境外不加偏移） */
export function wgs2gcj(lat, lon) {
  if (outOfChina(lat, lon)) return { lat, lon };
  const dLat = tLat(lon - 105.0, lat - 35.0);
  const dLon = tLon(lon - 105.0, lat - 35.0);
  const rad = (lat / 180.0) * Math.PI;
  const magic = 1 - EE * Math.sin(rad) * Math.sin(rad);
  const sqrtMagic = Math.sqrt(magic);
  const dLatOut = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * Math.PI);
  const dLonOut = (dLon * 180.0) / ((A / sqrtMagic) * Math.cos(rad) * Math.PI);
  return { lat: lat + dLatOut, lon: lon + dLonOut };
}

/** GCJ-02 → WGS-84（一次迭代反解，实测往返误差 < 20 m，够用） */
export function gcj2wgs(lat, lon) {
  if (outOfChina(lat, lon)) return { lat, lon };
  const g = wgs2gcj(lat, lon);
  return { lat: lat - (g.lat - lat), lon: lon - (g.lon - lon) };
}

function outOfChina(lat, lon) {
  return !(lon > 73.66 && lon < 135.05 && lat > 3.86 && lat < 53.55);
}

function tLat(x, y) {
  let r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  r += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  r += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
  return r;
}

function tLon(x, y) {
  let r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  r += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  r += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
  return r;
}

/** 两点球面距离（米）。**传入的两点必须同一坐标系**。 */
export function haversineM(a, b) {
  const lat1 = Number(a.lat);
  const lon1 = Number(a.lon);
  const lat2 = Number(b.lat);
  const lon2 = Number(b.lon);
  const p = Math.PI / 180;
  const h =
    Math.sin(((lat2 - lat1) * p) / 2) ** 2 +
    Math.cos(lat1 * p) * Math.cos(lat2 * p) * Math.sin(((lon2 - lon1) * p) / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 中位数点（对 GPS 抖动鲁棒；比平均值更抗离群点） */
export function medianPoint(points) {
  if (!points || !points.length) return null;
  const lats = points.map((p) => Number(p.lat)).sort((x, y) => x - y);
  const lons = points.map((p) => Number(p.lon)).sort((x, y) => x - y);
  const mid = Math.floor(lats.length / 2);
  const med = (arr) => (arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2);
  return { lat: med(lats), lon: med(lons) };
}

/** 分位数（p ∈ [0,1]，线性插值） */
export function percentile(values, p) {
  const arr = values.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (!arr.length) return null;
  const pos = (arr.length - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? arr[lo] : arr[lo] + (arr[hi] - arr[lo]) * (pos - lo);
}

/** 把点集（WGS-84）摘要成「中心 + 建议半径」，供围栏自适应（D-073） */
export function clusterSummary(points, opts = {}) {
  const minRadius = opts.minRadius ?? 300;
  const maxRadius = opts.maxRadius ?? 900;
  const center = medianPoint(points);
  if (!center) return null;
  const dists = points.map((p) => haversineM(center, p));
  const p95 = percentile(dists, 0.95) ?? 0;
  const radius = Math.round(Math.min(maxRadius, Math.max(minRadius, p95 * 1.6)));
  return {
    center,
    radius_m: radius,
    count: points.length,
    p50: Math.round(percentile(dists, 0.5) ?? 0),
    p95: Math.round(p95),
    max: Math.round(Math.max(...dists)),
  };
}

/**
 * 轨迹平滑：向心 Catmull-Rom 样条（D-085）。
 *
 * 为什么不用 Chaikin：Chaikin 是「切角」算法，实测把 45 个采样点平滑后，
 * 原始点离平滑线平均 19.4m、最大 110m —— 路口会被抹掉一块，等于又改了事实。
 * Catmull-Rom 是「过点插值」：曲线严格穿过每个采样点，只在点与点之间补弧线，
 * 观感顺滑但每个采样点的位置一点没动（用户要求「以 A 为准，别为了美观失去事实」）。
 *
 * @param {Array<{lat:number,lon:number}>} points 采样点（已转 GCJ）
 * @param {number} perSeg 每段插值点数（1 段 → perSeg+1 个输出点）
 */
export function smoothPath(points, perSeg = 8) {
  let pts = (points || [])
    .map((p) => ({ lat: Number(p.lat), lon: Number(p.lon) }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (pts.length < 3) return pts;

  // 先去掉「几乎同一个点」的重复采样（停车时车机会连报同一坐标），
  // 否则 Catmull-Rom 在重复点上会打结、画出一团毛刺（D-085 踩坑）
  const dedup = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const prev = dedup[dedup.length - 1];
    if (Math.abs(pts[i].lat - prev.lat) > 2e-5 || Math.abs(pts[i].lon - prev.lon) > 2e-5) dedup.push(pts[i]);
  }
  if (dedup.length < 3) return dedup;
  pts = dedup;

  // 向心参数化（alpha=0.5）能避免等距参数化在急转弯处的自交/尖点
  const alpha = 0.5;
  const dist = (a, b) => Math.pow(Math.hypot(b.lat - a.lat, b.lon - a.lon), alpha) || 1e-6;
  const lerp = (a, b, t) => ({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t });

  const out = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const t0 = 0;
    const t1 = t0 + dist(p0, p1);
    const t2 = t1 + dist(p1, p2);
    const t3 = t2 + dist(p2, p3);
    for (let k = 1; k <= perSeg; k++) {
      const t = t1 + ((t2 - t1) * k) / perSeg;
      const a1 = lerp(p0, p1, (t - t0) / (t1 - t0));
      const a2 = lerp(p1, p2, (t - t1) / (t2 - t1));
      const a3 = lerp(p2, p3, (t - t2) / (t3 - t2));
      const b1 = lerp(a1, a2, (t - t0) / (t2 - t0));
      const b2 = lerp(a2, a3, (t - t1) / (t3 - t1));
      out.push(lerp(b1, b2, (t - t1) / (t2 - t1)));
    }
  }
  return out;
}

export const __test = { wgs2gcj, gcj2wgs, haversineM, medianPoint, percentile, clusterSummary, smoothPath };
