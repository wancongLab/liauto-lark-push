/**
 * 高德静态地图（底图）+ Web Mercator 投影（D-079）
 *
 * 背景：静态地图的 `paths=` 画不了折线（D-076 实测 `20003`，见 amap.js 头注释）。
 * 但**底图本身**是好的（`location+zoom+size` 一次一张 PNG）。
 * 于是：Worker 用 secret 里的 key 拉一张「不带任何标记」的底图 → 前端用同一套
 * Mercator 参数把线路折线画成 SVG 叠在图上。等价于「静态底图 + 自己画线」，
 * 既不用 JS API（前端拿不到 key）、也不受 `paths` 限制。
 *
 *  两个必须一致的地方（错一个线就偏）：
 *   1. 底图请求的 `location`/`zoom` 必须与前端算像素用的中心/缩放**完全一致**；
 *   2. 高德底图是 GCJ-02，所以传进来的点必须先 `wgs2gcj()`（collector 入库时已转好）。
 *
 * 配额：静态地图 5000/日（个人认证）。每行程只渲染一张，且用 Cache API 缓存 7 天，
 * 重复打开不重复计数。
 */
import { AmapError, hasKey } from "./amap.js";

const BASE = "https://restapi.amap.com";
const TILE = 256;
const MAX_LAT = 85.05112878;

/** 底图尺寸（CSS 像素）；手机竖屏按 640×420 出图，够清晰也不浪费配额 */
export const MAP_W = 640;
export const MAP_H = 420;

/** 经纬度 → Web Mercator 世界像素（zoom 下的像素坐标） */
export function project(lat, lon, zoom) {
  const world = TILE * Math.pow(2, zoom);
  const x = ((lon + 180) / 360) * world;
  const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, Number(lat)));
  const rad = (clamped * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * world;
  return { x, y };
}

/** 世界像素 → 经纬度（project 的逆） */
export function unproject(x, y, zoom) {
  const world = TILE * Math.pow(2, zoom);
  const lon = (x / world) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / world;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lon };
}

/**
 * 按线路点的 bbox 选中心与缩放，保证所有点落在 (w-2*pad, h-2*pad) 内。
 * 单点或极短行程会给一个固定 zoom，避免除零。
 */
export function fitView(points, w = MAP_W, h = MAP_H, pad = 46, minZoom = 4, maxZoom = 17, padBottom = null) {
  // padBottom：底部额外留白（embed 截图底部有渐变数据条，避免路线被压住）
  const padB = padBottom == null ? pad : padBottom;
  const pts = (points || []).filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon));
  //  没有轨迹点时的兜底视野：用示例城市中心（不要写作者所在城市的真实坐标）
  if (!pts.length) return { center: { lat: 30.0, lon: 120.0 }, zoom: 12, empty: true };
  if (pts.length === 1) return { center: { lat: pts[0].lat, lon: pts[0].lon }, zoom: 15, empty: false };

  for (let z = maxZoom; z >= minZoom; z--) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) {
      const q = project(p.lat, p.lon, z);
      if (q.x < minX) minX = q.x;
      if (q.x > maxX) maxX = q.x;
      if (q.y < minY) minY = q.y;
      if (q.y > maxY) maxY = q.y;
    }
    if (maxX - minX <= w - pad * 2 && maxY - minY <= h - pad - padB) {
      // 上下留白不同 → 中心要按留白差补偿，否则底部内容仍会被裁
      const c = unproject((minX + maxX) / 2, (minY + maxY) / 2 + (padB - pad) / 2, z);
      return { center: { lat: c.lat, lon: c.lon }, zoom: z, empty: false };
    }
  }
  const c = unproject(
    (Math.min(...pts.map((p) => project(p.lat, p.lon, minZoom).x)) + Math.max(...pts.map((p) => project(p.lat, p.lon, minZoom).x))) / 2,
    (Math.min(...pts.map((p) => project(p.lat, p.lon, minZoom).y)) + Math.max(...pts.map((p) => project(p.lat, p.lon, minZoom).y))) / 2,
    minZoom,
  );
  return { center: { lat: c.lat, lon: c.lon }, zoom: minZoom, empty: false };
}

function buildAmapUrl(env, { center, zoom, w = MAP_W, h = MAP_H, scale = 1 }) {
  const qs = new URLSearchParams({
    location: `${center.lon.toFixed(6)},${center.lat.toFixed(6)}`,
    zoom: String(zoom),
    size: `${w}*${h}`,
    scale: String(scale),
    key: env.AMAP_KEY,
  });
  return `${BASE}/v3/staticmap?${qs.toString()}`;
}

export async function fetchStaticMap(env, opts) {
  if (!hasKey(env)) throw new AmapError("缺少 AMAP_KEY");
  const url = buildAmapUrl(env, opts);
  const w = opts.w || MAP_W;
  const h = opts.h || MAP_H;
  const cacheKey = new Request(
    `https://staticmap.internal/${opts.zoom}/${opts.center.lat.toFixed(5)},${opts.center.lon.toFixed(5)}/${w}x${h}/${opts.scale || 1}.png`,
  );

  const cache = typeof caches !== "undefined" && caches.default ? caches.default : null;
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const ct = res.headers.get("Content-Type") || "";
  if (!res.ok || !ct.startsWith("image/")) {
    const txt = ct.startsWith("image/") ? "" : await res.text();
    throw new AmapError(`静态图失败 HTTP ${res.status}`, { body: txt.slice(0, 300), url: url.replace(/key=[^&]+/, "key=***") });
  }
  const out = new Response(res.body, {
    headers: { "Content-Type": ct, "Cache-Control": "public, max-age=604800" },
  });
  if (cache) {
    try { await cache.put(cacheKey, out.clone()); } catch { /* 缓存失败不影响返回 */ }
  }
  return out;
}

export const __test = { project, unproject, fitView };
