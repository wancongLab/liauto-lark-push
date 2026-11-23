/**
 * 行程分享页 `/t/<token>`（D-079）
 *
 * 设计取舍：
 *   - **免登录**：飞书内置浏览器点链接时没有面板 cookie，登录流程走不通（用户实测 "bad token"）；
 *     用签名短链代替登录，链接本身即凭证，14 天过期。
 *   - **最小信息面**：只渲染这一条行程（里程/时长/电量/起止地点/线路），
 *     不出现 VIN、车牌、其他行程、面板入口 —— 链接外泄的损失被限制在「一条行程的地图」。
 *   - **底图由 Worker 代取**：静态地图 key 只在 Worker secret 里，浏览器只请求 `/t/<token>/bg.png`，
 *     前端拿不到 key，也不吃 JS API 配额。
 *   - **折线自己画**：静态地图 `paths=` 不可用（D-076），所以用 Web Mercator 把点投到
 *     与底图完全相同的中心/缩放上，用 SVG 叠一层。
 */
import * as db from "./db.js";
import { verifyTripToken } from "./tripShare.js";
import { MAP_W, MAP_H, project, fitView, fetchStaticMap } from "./staticmap.js";

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtDuration(min) {
  const m = Number(min);
  if (!Number.isFinite(m) || m <= 0) return "—";
  if (m < 60) return `${Math.round(m)} 分`;
  return `${Math.floor(m / 60)} 小时 ${Math.round(m % 60)} 分`;
}

function shortPlace(s) {
  const t = String(s || "").replace(/^.{2,6}省.{2,6}市(?=.)/, "").replace(/^.{2,6}市(?=.)/, "");
  return t.length > 16 ? `${t.slice(0, 16)}…` : t || "—";
}

function parseRoute(raw) {
  if (!raw) return [];
  try {
    const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr)) return [];
    return arr
      .map((p) => (Array.isArray(p) ? { lon: Number(p[0]), lat: Number(p[1]) } : { lon: Number(p.lon), lat: Number(p.lat) }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  } catch {
    return [];
  }
}

function html({ trip, points, view, cost, tokenExp, embed = false, embedBg = "", amapv = "1.4.15", carName = "" }) {
  const W = MAP_W, H = MAP_H;
  const pct = Math.abs((Number(trip.battery_from) || 0) - (Number(trip.battery_to) || 0));
  const batt = trip.battery_from != null && trip.battery_to != null ? `${trip.battery_from}% → ${trip.battery_to}%` : "—";
  //  D-195：电量变化写成带符号的差值（−13% / +8% / 0%）。原来只有绝对值「（13%）」，
  //  单独一个数字看不出是掉了还是涨了 —— 用户原话「一下子反应不过来」。
  const socDelta = trip.battery_from != null && trip.battery_to != null
    ? Number(trip.battery_to) - Number(trip.battery_from) : null;
  const socText = socDelta == null || !Number.isFinite(socDelta)
    ? ""
    : socDelta === 0 ? "0%" : `${socDelta > 0 ? "+" : "−"}${Math.abs(socDelta)}%`;
  const elec = trip.elec_km != null ? `${Number(trip.elec_km).toFixed(1)} km` : "—";
  const engine = trip.engine_km != null ? `${Number(trip.engine_km).toFixed(1)} km` : "—";
  const avgKmh = Number(trip.duration_min) > 0 ? (Number(trip.distance_km || 0) / (Number(trip.duration_min) / 60)) : null;
  // 用上海日期（+8h）而不是 UTC 日期，避免链接到期日显示差一天
  const expText = tokenExp ? new Date((tokenExp + 8 * 3600) * 1000).toISOString().slice(0, 10) : "";

  const data = {
    embed: Boolean(embed),
    cx: Number(view.center.lon.toFixed(6)),
    cy: Number(view.center.lat.toFixed(6)),
    z: view.zoom,
    w: W,
    h: H,
    pts: points.map((p) => [Number(p.lon.toFixed(6)), Number(p.lat.toFixed(6))]),
    tk: String(trip.__token || ""),
  };

  return `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<meta http-equiv="Cache-Control" content="no-store, must-revalidate">
<meta http-equiv="Pragma" content="no-cache">
<title>行程 ${esc(trip.started_at)} · ${Number(trip.distance_km || 0).toFixed(1)} km</title>
${embed ? "" : `<!-- D-195：preconnect 实测无效甚至更慢（4G 节流 FCP 3,584 → 5,392 ms），故不预连；见决策日志 -->
<script>window._AMapSecurityConfig = { securityJsCode: "YOUR_AMAP_SECURITY_CODE" };</script>
<script async src="https://webapi.amap.com/maps?v=${amapv}&key=YOUR_AMAP_JS_KEY" referrerpolicy="origin"></script>`}
<style>
:root{--bg:#0f1419;--bg-2:#151d26;--card:#1a2430;--line:#243141;--line-soft:#1e2a38;--fg:#e8eef5;--fg-2:#b9c7d6;--dim:#8ea0b4;--accent:#4f8cff;--accent-ink:#9fc3ff;--green:#35c48c;--amber:#f0a92e;--red:#f0554d;--r-lg:16px;--r-md:12px;--r-sm:10px;--tap:44px;--fs-label:12px}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",system-ui,sans-serif}
.wrap{max-width:560px;margin:0 auto;padding:0 0 20px}
.head{padding:12px 14px 8px}
.head h1{margin:0;font-size:18px;font-weight:650}
.head .sub{margin-top:3px;color:var(--dim);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mapbox{position:relative;width:100%;aspect-ratio:${W}/${H};background:var(--bg-2);overflow:hidden;border-top:1px solid var(--line);border-bottom:1px solid var(--line);touch-action:pan-y;overscroll-behavior:contain}
.mapbox #bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.mapbox #route{position:absolute;inset:0;width:100%;height:100%;display:block}
.mapbox .noimg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--dim);font-size:13px}
.maplink{position:absolute;left:12px;bottom:44px;z-index:20;font-size:var(--fs-label);color:var(--accent-ink);background:rgba(15,20,25,.72);border:1px solid rgba(120,170,255,.35);border-radius:999px;padding:5px 10px;cursor:pointer;display:none}
.tilehint{position:absolute;z-index:20;left:10px;top:10px;display:none;font-size:var(--fs-label);color:#cbd7e4;background:rgba(8,12,17,.72);border:1px solid rgba(255,255,255,.1);padding:3px 9px;border-radius:999px}
.zoomer{position:absolute;z-index:20;right:10px;bottom:10px;display:flex;flex-direction:column;gap:6px}
.zoomer button{width:36px;height:36px;border-radius:10px;border:1px solid var(--line);background:rgba(26,36,48,.92);color:var(--fg);font-size:18px;line-height:1}
.stats{display:grid;grid-template-columns:repeat(2,1fr);gap:1px;background:var(--line);border-top:1px solid var(--line)}
.stats div{background:var(--card);padding:9px 12px}
.stats .k{color:var(--dim);font-size:var(--fs-label)}
.stats .v{font-size:15px;font-weight:600;margin-top:1px}
.stats .v.small{font-size:13px;font-weight:500}
.places{padding:10px 14px 0;display:flex;flex-direction:column;gap:6px}
.place{display:flex;gap:7px;font-size:13px;color:var(--fg-2);align-items:flex-start}
.place span{overflow-wrap:anywhere;min-width:0}
.place i{flex:0 0 auto;width:18px;height:18px;border-radius:50%;font-style:normal;font-size:11px;display:flex;align-items:center;justify-content:center;margin-top:1px}
.place.s i{background:var(--green);color:#04140a}
.place.e i{background:var(--amber);color:#1a0c02}
.note{padding:10px 14px 0;color:var(--dim);font-size:var(--fs-label);line-height:1.55}
body.embed .wrap{max-width:none;padding:0}
body.embed .head,body.embed .stats,body.embed .places,body.embed .note,body.embed .zoomer{display:none}
body.embed .mapbox{aspect-ratio:auto;height:100vh;border:0}
body.embed .ov{position:absolute;left:0;right:0;bottom:0;display:flex;gap:20px;align-items:flex-end;padding:76px 18px 14px;background:linear-gradient(to top,rgba(5,9,14,.965) 0%,rgba(5,9,14,.955) 46%,rgba(5,9,14,.62) 78%,rgba(5,9,14,0) 100%);text-shadow:0 1px 3px rgba(0,0,0,.85)}
body.embed .ov .m{display:flex;flex-direction:column;gap:1px;min-width:0}
body.embed .ov .m .k{color:#9fb0c2;font-size:11px;letter-spacing:.03em}
body.embed .ov .m .v{color:#fff;font-size:19px;font-weight:700;line-height:1.15}
body.embed .ov .m.big .v{font-size:25px}
#mapbox{touch-action:none;overscroll-behavior:contain}
.mzlayer{position:absolute;inset:0;transform-origin:0 0;touch-action:none;will-change:transform}
.mzlayer #bg,.mzlayer #route{position:absolute;inset:0;width:100%;height:100%;display:block}
.tiles{position:absolute;inset:0;overflow:hidden}
.tiles img{position:absolute;left:0;top:0;width:256px;height:256px;max-width:none;pointer-events:none;user-select:none}
.tiles img.ph{opacity:0}
.zoomer button{width:38px;height:38px;font-size:20px;line-height:1}
body.embed .maplink{display:none!important}
body.embed .badge{position:absolute;left:16px;top:14px;font-size:12.5px;color:#e3ebf4;background:rgba(8,12,17,.66);border:1px solid rgba(255,255,255,.08);padding:4px 10px;border-radius:999px}
</style></head><body class="${embed ? "embed" : ""}"><div class="wrap">
<div class="head">
  <h1>${esc(carName || "行程")}</h1>
  <div class="sub">${esc(String(trip.started_at || "").slice(0, 16))} → ${esc(String(trip.ended_at || "").slice(11, 16) || "")} · ${Number(trip.distance_km || 0).toFixed(1)} km</div>
</div>
<div class="mapbox" id="mapbox">
  <div class="mzlayer" id="mzlayer">
  <div class="tiles" id="tiles"></div>
  <img id="bg" alt="" data-src="${embedBg ? embedBg : `/t/${esc(trip.__token || "")}/bg.png?z=${view.zoom}&cx=${data.cx}&cy=${data.cy}${embed ? "" : "&s=2"}`}">
  <div class="noimg" id="noimg" style="display:none">底图加载失败，仅显示线路形状</div>
  <svg id="route" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice">
    <defs><filter id="glow"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
    <polyline id="line" fill="none" stroke="#4f8cff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" opacity=".95" filter="url(#glow)"/>
    <circle id="p0" r="7" fill="#35c48c" stroke="#0f1419" stroke-width="2"/>
    <circle id="p1" r="7" fill="#f0a92e" stroke="#0f1419" stroke-width="2"/>
  </svg>
  </div>
  ${embed ? `<div class="badge">${esc(String(trip.started_at || "").slice(5, 16))} · ${Number(trip.distance_km || 0).toFixed(1)} km</div>
  <div class="ov">
    <div class="m big"><div class="k">里程</div><div class="v">${Number(trip.distance_km || 0).toFixed(1)} km</div></div>
    <div class="m"><div class="k">时长</div><div class="v">${esc(fmtDuration(trip.duration_min))}</div></div>
    <div class="m"><div class="k">耗电 / 电费</div><div class="v">${cost ? `${cost.kwh.toFixed(1)} kWh / ¥${cost.cny.toFixed(2)}` : "—"}</div></div>
    <div class="m"><div class="k">电量</div><div class="v">${trip.battery_from != null && trip.battery_to != null ? `${trip.battery_from}%→${trip.battery_to}%` : "—"}</div></div>
  </div>` : ""}
  <div class="zoomer"><button id="zin" aria-label="放大">+</button><button id="zout" aria-label="缩小">−</button><button id="zreset" aria-label="复位" class="mini">1:1</button></div>
</div>
<div class="stats">
  <div><div class="k">里程</div><div class="v">${Number(trip.distance_km || 0).toFixed(1)} km</div></div>
  <div><div class="k">时长</div><div class="v">${esc(fmtDuration(trip.duration_min))}</div></div>
  <div><div class="k">纯电 / 发动机</div><div class="v small">${esc(elec)} / ${esc(engine)}</div></div>
  <div><div class="k">平均车速</div><div class="v small">${avgKmh != null ? avgKmh.toFixed(0) + " km/h" : "—"}</div></div>
  <div><div class="k">电量变化</div><div class="v small">${esc(batt)}${socText ? `（${socText}）` : ""}</div></div>
  <div><div class="k">本程耗电 / 电费</div><div class="v small">${cost ? `${cost.kwh.toFixed(1)} kWh / ¥${cost.cny.toFixed(2)}` : "—"}</div></div>
</div>
<div class="places">
  <div class="place s"><i>起</i><span>${esc(shortAddr(trip.start_loc))}</span></div>
  <div class="place e"><i>终</i><span>${esc(shortAddr(trip.end_loc))}</span></div>
</div>
<div class="note">${cost ? `电费按 ${esc(cost.priceAt || "")} 那次充电的电价（${cost.price} 元/度）结算。` : ""}<br>轨迹来自车机 1 分钟采样点（已平滑），里程以车机里程表为准。${expText ? `<br>此链接仅本人可见，${expText} 前有效；面板内永久可查。` : ""}</div>
</div>
<script>
(function(){
  var D = ${JSON.stringify(data)};
  // AMap 的 map.destroy() 会清空容器 → 先把我们自己的节点抓住，降级时再挂回去
  var KEEP = {
    bg: document.getElementById('bg'), route: document.getElementById('route'),
    noimg: document.getElementById('noimg'), tilehint: document.getElementById('tilehint'),
    maplink: document.getElementById('maplink'),
    zoomer: document.querySelector('#mapbox .zoomer')
  };
  var TILE = 256, MAXLAT = 85.05112878;
  function merc(lat, lon, z){
    var world = TILE * Math.pow(2, z);
    var x = ((lon + 180) / 360) * world;
    var la = Math.max(-MAXLAT, Math.min(MAXLAT, lat));
    var rad = la * Math.PI / 180;
    var y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * world;
    return { x: x, y: y };
  }
  var readyDone = false;
  function markReady(){ if (readyDone) return; readyDone = true; document.documentElement.classList.add('ready'); }

  // ── D-158：分享页统一「静态底图 + 自研手势」，不再加载高德 JS API。
  //    为什么（两轮实测）：① 手机上高德 1.4.15 在 Safari/webview 里反复出现「有 canvas 没地图」的白屏，
  //    且无法用像素判断死活；② 双指缩放会连带整页放大（用户的真实痛点）。
  //    自绘图层由我们完全控制：拖动 / 双指 / 滚轮 / 按钮都只作用于这一层。
  function drawStatic(){
    if (window.__staticInited) return;
    window.__staticInited = true;
    var c = merc(D.cy, D.cx, D.z);
    var px = D.pts.map(function(p){ var q = merc(p[1], p[0], D.z); return [q.x - c.x + D.w/2, q.y - c.y + D.h/2]; });
    var line = document.getElementById('line');
    line.setAttribute('points', px.map(function(p){ return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' '));
    if (px.length) {
      var a = px[0], b = px[px.length - 1];
      var p0 = document.getElementById('p0'), p1 = document.getElementById('p1');
      p0.setAttribute('cx', a[0]); p0.setAttribute('cy', a[1]);
      p1.setAttribute('cx', b[0]); p1.setAttribute('cy', b[1]);
    }
    var img = document.getElementById('bg');
    //  D-166：截图（Browser Rendering）里底图偶发取不到 → 只剩黑底 + 蓝线。
    //   改成「最多 3 次带 cache-bust 的重试 + 每次上报 diag」，成功/彻底失败才 markReady，
    //   避免截图在底图还没就绪时就被拍下。
    var bgTry = 0, bgDone = false;
    function finishBg(ok){
      if (bgDone) return;
      bgDone = true;
      if (!ok) {
        var n = document.getElementById('noimg'); if (n) n.style.display = 'flex';
        img.style.visibility = 'hidden';
      }
      if (D.embed) reportDiag(ok ? 'bg-ok' : 'bg-fail', { n: String(bgTry), nat: String(img.naturalWidth || 0) });
      markReady();
    }
    function loadBg(){
      bgTry++;
      var base = img.dataset.src || '';
      if (!base) { finishBg(false); return; }
      //  D-200：embed 模式下 data-src 可能是内联的 data: URL，拼 &r= 会把它弄坏
      img.src = (bgTry > 1 && base.indexOf('data:') !== 0) ? base + '&r=' + bgTry : base;
    }
    img.addEventListener('error', function(){
      if (bgTry < 3) { setTimeout(loadBg, 900); return; }
      finishBg(false);
    });
    img.addEventListener('load', function(){
      if (img.naturalWidth > 0) finishBg(true);
    });
    loadBg();
    setTimeout(function(){ if (!bgDone && img.naturalWidth > 0) finishBg(true); }, 7000);

    var box = document.getElementById('mapbox');
    var layer = document.getElementById('mzlayer');
    var S = 1, TX = 0, TY = 0, MIN = 1, MAX = 6;
    function clamp(){
      var w = box.clientWidth || 1, h = box.clientHeight || 1;
      S = Math.max(MIN, Math.min(MAX, S));
      TX = Math.min(0, Math.max(w - w * S, TX));
      TY = Math.min(0, Math.max(h - h * S, TY));
    }
    function apply(){
      clamp();
      if (layer) layer.style.transform = 'translate3d(' + TX.toFixed(1) + 'px,' + TY.toFixed(1) + 'px,0) scale(' + S.toFixed(4) + ')';
    }
    function zoomAt(factor, cx, cy){
      var ns = Math.max(MIN, Math.min(MAX, S * factor));
      if (Math.abs(ns - S) < 1e-6) return;
      var w = box.clientWidth || 1, h = box.clientHeight || 1;
      if (cx == null) { cx = w / 2; cy = h / 2; }
      TX = cx - (cx - TX) * (ns / S);
      TY = cy - (cy - TY) * (ns / S);
      S = ns;
      apply();
    }
    var zin = document.getElementById('zin'), zout = document.getElementById('zout');
    if (zin) zin.addEventListener('click', function(e){ e.preventDefault(); e.stopPropagation(); zoomAt(1.5); });
    if (zout) zout.addEventListener('click', function(e){ e.preventDefault(); e.stopPropagation(); zoomAt(1 / 1.5); });
    var zr = document.getElementById('zreset');
    if (zr) zr.addEventListener('click', function(e){ e.preventDefault(); e.stopPropagation(); S = 1; TX = 0; TY = 0; apply(); });

    var dragging = false, lx = 0, ly = 0, pinch = null;
    box.addEventListener('pointerdown', function(e){
      if (e.pointerType === 'touch' && e.isPrimary === false) return;
      if (e.button && e.button !== 0) return;
      dragging = !pinch; lx = e.clientX; ly = e.clientY;
      try { box.setPointerCapture(e.pointerId); } catch (_) {}
    });
    box.addEventListener('pointermove', function(e){
      if (!dragging || pinch) return;
      TX += e.clientX - lx; TY += e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      apply();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function(t){
      box.addEventListener(t, function(){ dragging = false; });
    });
    box.addEventListener('touchstart', function(e){
      if (e.touches.length === 2) {
        dragging = false;
        var a = e.touches[0], b = e.touches[1];
        pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1, s: S };
        e.preventDefault();
      }
    }, { passive: false });
    box.addEventListener('touchmove', function(e){
      if (!pinch || e.touches.length !== 2) return;
      var a = e.touches[0], b = e.touches[1];
      var d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
      var rect = box.getBoundingClientRect();
      zoomAt((pinch.s * (d / pinch.d)) / S, (a.clientX + b.clientX) / 2 - rect.left, (a.clientY + b.clientY) / 2 - rect.top);
      e.preventDefault();
    }, { passive: false });
    box.addEventListener('touchend', function(e){
      if (e.touches.length < 2) {
        // D-193：捏合结束时报一次结果（自研瓦片模式用 S 表示缩放倍率）
        if (pinch && pinch.z !== view.z && !pinch.sent) {
          pinch.sent = true;
          reportDiag('pinch', {
            mode: 'tiles', z0: String(Math.round(pinch.z * 100) / 100), z1: String(Math.round(view.z * 100) / 100),
            vv0: '1',
            vv1: String(window.visualViewport ? Math.round(window.visualViewport.scale * 1000) / 1000 : 1),
            sy: String(Math.round(window.scrollY)),
            canvas: '0', imgs: String(box.querySelectorAll('img').length),
          });
        }
        pinch = null;
      }
    });
    box.addEventListener('wheel', function(e){
      e.preventDefault();
      var rect = box.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - rect.left, e.clientY - rect.top);
    }, { passive: false });
    var lastTap = 0;
    box.addEventListener('click', function(e){
      var now = Date.now();
      if (now - lastTap < 320) {
        var rect = box.getBoundingClientRect();
        zoomAt(S >= 2.5 ? 1 / S : 2, e.clientX - rect.left, e.clientY - rect.top);
      }
      lastTap = now;
    });
    apply();
    window.__mapZoom = function(){ return { s: S, tx: TX, ty: TY }; };
    window.__amapMode = false;
    markReady();
  }

  // ── D-160：恢复「高德 JS API 原生交互地图」为主路径（用户要求保留原样）。
  //    之前真机白屏/黄屏的原因还没被证实，所以这次同时做两件事：
  //    ① 原样恢复 AMap.Map（缩放/拖动/自带瓦片与字号都由高德负责）；
  //    ② 挂诊断：8 秒后把「瓦片张数 / canvas 尺寸 / 容器尺寸 / 控制台报错 / 高德版本」
  //       回传给 Worker 入库（runtime_state['mapdiag']），下次真机白屏能直接看到原因。
  //    兜底：AMap 脚本没起来 / 8 秒后仍然一张瓦片都没铺上 → 自动切到自研瓦片渲染器（drawTiles）。
  var mapErrs = [];
  window.addEventListener('error', function(e){ if (mapErrs.length < 6) mapErrs.push(String((e && e.message) || '').slice(0, 160)); });
  function reportDiag(kind, extra){
    try {
      var q = new URLSearchParams();
      q.set('k', kind);
      q.set('ua', (navigator.userAgent || '').slice(0, 120));
      q.set('box', (document.getElementById('mapbox') || {}).clientWidth + 'x' + (document.getElementById('mapbox') || {}).clientHeight);
      q.set('dpr', String(window.devicePixelRatio || 1));
      q.set('vv', String(window.visualViewport ? window.visualViewport.scale : 1));
      if (extra) Object.keys(extra).forEach(function(k2){ q.set(k2, extra[k2]); });
      q.set('errs', mapErrs.join(' | ').slice(0, 400));
      fetch('/t/' + (D.tk || '') + '/diag?' + q.toString(), { keepalive: true }).catch(function(){});
    } catch (_) {}
  }
  function initAmap(){
    var box = document.getElementById('mapbox');
    var z = Math.max(3, Math.min(18, Math.round(D.z)));
    var map = new AMap.Map(box, {
      zoom: z, center: [D.cx, D.cy], viewMode: '2D', resizeEnable: true,
      mapStyle: 'amap://styles/normal'
    });
    var path = D.pts.map(function(p){ return [p[0], p[1]]; });
    var poly = new AMap.Polyline({
      path: path, strokeColor: '#4f8cff', strokeWeight: 6, strokeOpacity: 0.95,
      lineJoin: 'round', lineCap: 'round', showDir: true
    });
    function dot(color){
      return '<div style="width:14px;height:14px;border-radius:50%;background:' + color +
        ';border:2px solid #0f1419;box-sizing:border-box;box-shadow:0 0 0 2px rgba(255,255,255,.35)"></div>';
    }
    var start = new AMap.Marker({ position: path[0], content: dot('#35c48c'), offset: new AMap.Pixel(-7, -7) });
    var end = new AMap.Marker({ position: path[path.length - 1], content: dot('#f0a92e'), offset: new AMap.Pixel(-7, -7) });
    map.add([poly, start, end]);
    function applyFit(){
      if (box.clientWidth < 80 || box.clientHeight < 60) return;
      var bb = poly.getBounds();
      if (!bb) { map.setFitView([poly, start, end], false, [40, 40, 40, 40]); return; }
      var size = { width: box.clientWidth, height: box.clientHeight };
      var sw = bb.getSouthWest(), ne = bb.getNorthEast();
      var q1 = merc(ne.lat, sw.lng, 0), q2 = merc(sw.lat, ne.lng, 0);
      var dx = Math.abs(q2.x - q1.x) || 1, dy = Math.abs(q2.y - q1.y) || 1;
      var padX = 24, padT = 24, padB = 24;
      var zfit = Math.min(
        Math.log2(Math.max(1, size.width - padX * 2) / dx),
        Math.log2(Math.max(1, size.height - padT - padB) / dy)
      );
      zfit = Math.max(3, Math.min(18, zfit));
      map.setZoomAndCenter(zfit, centerOf(bb));
    }
    function centerOf(bb){
      var sw = bb.getSouthWest(), ne = bb.getNorthEast();
      return [ (sw.lng + ne.lng) / 2, (sw.lat + ne.lat) / 2 ];
    }
    applyFit();
    map.on('complete', function(){
      applyFit();
      setTimeout(function(){
        var imgs = box.querySelectorAll('img[class^="xyz-"]').length;
        var canv = box.querySelectorAll('canvas').length;
        reportDiag('amap-ok', { imgs: String(imgs), canvas: String(canv), ver: (window.AMap && AMap.version) || '?' });
        if (canv > 0 && imgs === 0) { /* canvas 渲染，无法判断，交给人眼 */ }
        markReady();
      }, 1200);
    });
    setTimeout(applyFit, 400);
    setTimeout(applyFit, 1200);
    window.addEventListener('resize', applyFit);
    // 8 秒体检：一张瓦片都没铺上、也没有 canvas → 判定真机失败，回落自研瓦片
    setTimeout(function(){
      var imgs = box.querySelectorAll('img[class^="xyz-"]').length;
      var canv = box.querySelectorAll('canvas').length;
      reportDiag('amap-check', { imgs: String(imgs), canvas: String(canv), ver: (window.AMap && AMap.version) || '?' });
      if (imgs === 0 && canv === 0) {
        try { map.destroy(); } catch (_) {}
        box.innerHTML = '';
        drawTiles();
      }
    }, 8000);
    window.__amapMode = true;
    window.__map = map;
    // ── D-193 / D-195：真机捏合自检。
    //    第一版挂在 AMap 的 zoomstart/zoomend 上，结果真机（iPhone）一次都没上报 —— 高德 1.4
    //    在手势缩放时派不派发这两个事件各端不一致，不能当依据。现在改成**自己量**：
    //    两指按下记 z0 / vv0，抬指后 300ms（等缩放动画落定）读 z1 / vv1 直接比，
    //    与高德内部事件无关。z1 === z0 也照报（那正是「捏了没反应」的证据）。
    var pinchSent = 0, g = null;
    box.addEventListener('touchstart', function(e){
      if (e.touches.length >= 2 && !g) {
        g = { z0: map.getZoom(), vv0: window.visualViewport ? window.visualViewport.scale : 1, t: Date.now(), pending: false };
      }
    }, { passive: true });
    box.addEventListener('touchend', function(e){
      if (!g || g.pending || e.touches.length >= 2) return;
      if (pinchSent >= 2) { g = null; return; }
      g.pending = true;
      setTimeout(function(){
        if (!g) return;
        pinchSent++;
        var rec = {
          mode: 'amap',
          z0: String(Math.round(g.z0 * 100) / 100),
          z1: String(Math.round(map.getZoom() * 100) / 100),
          vv0: String(Math.round(g.vv0 * 1000) / 1000),
          vv1: String(Math.round((window.visualViewport ? window.visualViewport.scale : 1) * 1000) / 1000),
          sy: String(Math.round(window.scrollY)),
          dt: String(Date.now() - g.t),
          canvas: String(box.querySelectorAll('canvas').length),
          imgs: String(box.querySelectorAll('img[class^="xyz-"]').length),
        };
        g = null;
        reportDiag('pinch', rec);
      }, 300);
    }, { passive: true });
  }

  // ── D-159：交互地图＝高德瓦片（经我们域名代理）+ 自研平移/缩放渲染。
  //    为什么不再用高德 JS API：真机上它反复「有 canvas 没地图」（黄屏），且双指缩放会
  //    连带整页放大（两次踩坑 D-084/D-156）。瓦片自己渲染后：缩放直接换 z 级瓦片，
  //    路名与 POI 随级别出现（不是把一张图放大），页面也不会跟着缩放。
  function drawTiles(){
    var box = document.getElementById('mapbox');
    var layer = document.getElementById('tiles');
    var svg = document.getElementById('route');
    var bg = document.getElementById('bg');
    if (bg) { bg.style.display = 'none'; }
    var TK = D.tk || '';
    var pts = D.pts || [];
    var TILE = 256, MAXLAT = 85.05112878, MINZ = 4, MAXZ = 18;
    function project(lat, lon, z){
      var world = TILE * Math.pow(2, z);
      var x = ((lon + 180) / 360) * world;
      var la = Math.max(-MAXLAT, Math.min(MAXLAT, lat));
      var rad = la * Math.PI / 180;
      var y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * world;
      return { x: x, y: y };
    }
    function unproject(x, y, z){
      var world = TILE * Math.pow(2, z);
      var lon = (x / world) * 360 - 180;
      var n = Math.PI - 2 * Math.PI * y / world;
      return { lat: (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), lon: lon };
    }
    function size(){ return { w: box.clientWidth || 390, h: box.clientHeight || 254 }; }
    var view = { z: 12, lat: D.cy, lon: D.cx };
    function fit(){
      var s = size(), pad = 26;
      if (pts.length > 1) {
        for (var z = MAXZ; z >= MINZ; z--) {
          var minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
          for (var i = 0; i < pts.length; i++) {
            var q = project(pts[i][1], pts[i][0], z);
            minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x);
            minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y);
          }
          if (maxX - minX <= s.w - pad * 2 && maxY - minY <= s.h - pad * 2) {
            var c = unproject((minX + maxX) / 2, (minY + maxY) / 2, z);
            view = { z: z, lat: c.lat, lon: c.lon };
            return;
          }
        }
      }
      view = { z: 14, lat: pts.length ? pts[0][1] : D.cy, lon: pts.length ? pts[0][0] : D.cx };
    }
    var pool = {};
    function render(){
      if (!layer) return;
      var s = size();
      var z = view.z, Z = Math.round(z), sc = Math.pow(2, z - Z);
      var c = project(view.lat, view.lon, Z);
      var halfW = s.w / (2 * sc), halfH = s.h / (2 * sc);
      var n = Math.pow(2, Z);
      var x0 = Math.floor((c.x - halfW) / TILE), x1 = Math.floor((c.x + halfW) / TILE);
      var y0 = Math.floor((c.y - halfH) / TILE), y1 = Math.floor((c.y + halfH) / TILE);
      var seen = {};
      for (var tx = x0; tx <= x1; tx++) {
        for (var ty = y0; ty <= y1; ty++) {
          if (ty < 0 || ty >= n) continue;
          var wx = ((tx % n) + n) % n, key = Z + '/' + wx + '/' + ty;
          seen[key] = 1;
          var img = pool[key];
          if (!img) {
            img = document.createElement('img');
            img.alt = ''; img.decoding = 'async';
            img.src = '/t/' + TK + '/tile/' + Z + '/' + wx + '/' + ty + '.png';
            layer.appendChild(img); pool[key] = img;
          }
          var px = Math.round((tx * TILE - c.x) * sc + s.w / 2);
          var py = Math.round((ty * TILE - c.y) * sc + s.h / 2);
          img.style.width = Math.ceil(TILE * sc) + 'px';
          img.style.height = Math.ceil(TILE * sc) + 'px';
          img.style.transform = 'translate(' + px + 'px,' + py + 'px)';
        }
      }
      for (var k in pool) { if (!seen[k]) { if (pool[k].parentNode) pool[k].parentNode.removeChild(pool[k]); delete pool[k]; } }
      // 线路：SVG 直接用屏幕坐标（viewBox 与容器同尺寸）
      svg.setAttribute('viewBox', '0 0 ' + s.w + ' ' + s.h);
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.style.width = s.w + 'px'; svg.style.height = s.h + 'px';
      var d = [];
      for (var i2 = 0; i2 < pts.length; i2++) {
        var q = project(pts[i2][1], pts[i2][0], Z);
        d.push(((q.x - c.x) * sc + s.w / 2).toFixed(1) + ',' + ((q.y - c.y) * sc + s.h / 2).toFixed(1));
      }
      var line = document.getElementById('line');
      if (line) {
        line.setAttribute('points', d.join(' '));
        var sw = Math.max(3, Math.min(7, 5 * Math.sqrt(sc)));
        line.setAttribute('stroke-width', sw.toFixed(1));
      }
      if (pts.length) {
        var a1 = project(pts[0][1], pts[0][0], Z), b1 = project(pts[pts.length - 1][1], pts[pts.length - 1][0], Z);
        var p0 = document.getElementById('p0'), p1 = document.getElementById('p1');
        if (p0) { p0.setAttribute('cx', (a1.x - c.x) * sc + s.w / 2); p0.setAttribute('cy', (a1.y - c.y) * sc + s.h / 2); }
        if (p1) { p1.setAttribute('cx', (b1.x - c.x) * sc + s.w / 2); p1.setAttribute('cy', (b1.y - c.y) * sc + s.h / 2); }
      }
    }
    function clampView(){
      view.z = Math.max(MINZ, Math.min(MAXZ, view.z));
      view.lat = Math.max(-MAXLAT, Math.min(MAXLAT, view.lat));
    }
    function zoomAround(newZ, px, py){
      newZ = Math.max(MINZ, Math.min(MAXZ, newZ));
      if (Math.abs(newZ - view.z) < 1e-6) return;
      var s = size(), Z0 = Math.round(view.z), sc0 = Math.pow(2, view.z - Z0);
      var c0 = project(view.lat, view.lon, Z0);
      var wx = c0.x + (px - s.w / 2) / sc0, wy = c0.y + (py - s.h / 2) / sc0;
      var Z1 = Math.round(newZ), sc1 = Math.pow(2, newZ - Z1), k = Math.pow(2, Z1 - Z0);
      var c1 = { x: wx * k - (px - s.w / 2) / sc1, y: wy * k - (py - s.h / 2) / sc1 };
      var u = unproject(c1.x, c1.y, Z1);
      view = { z: newZ, lat: u.lat, lon: u.lon };
      clampView(); render();
    }
    function panBy(dx, dy){
      var s = size(), Z = Math.round(view.z), sc = Math.pow(2, view.z - Z);
      var c = project(view.lat, view.lon, Z);
      var u = unproject(c.x - dx / sc, c.y - dy / sc, Z);
      view.lat = u.lat; view.lon = u.lon;
      clampView(); render();
    }
    var zin = document.getElementById('zin'), zout = document.getElementById('zout'), zr = document.getElementById('zreset');
    if (zin) zin.addEventListener('click', function(e){ e.preventDefault(); e.stopPropagation(); var s = size(); zoomAround(view.z + 0.75, s.w / 2, s.h / 2); });
    if (zout) zout.addEventListener('click', function(e){ e.preventDefault(); e.stopPropagation(); var s = size(); zoomAround(view.z - 0.75, s.w / 2, s.h / 2); });
    if (zr) zr.addEventListener('click', function(e){ e.preventDefault(); e.stopPropagation(); fit(); render(); });

    var dragging = false, lx = 0, ly = 0, pinch = null, moved = 0;
    box.addEventListener('pointerdown', function(e){
      if (e.button && e.button !== 0) return;
      dragging = !pinch; lx = e.clientX; ly = e.clientY; moved = 0;
      try { box.setPointerCapture(e.pointerId); } catch (_) {}
    });
    box.addEventListener('pointermove', function(e){
      if (!dragging || pinch) return;
      var dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX; ly = e.clientY; moved += Math.abs(dx) + Math.abs(dy);
      panBy(dx, dy);
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function(t){
      box.addEventListener(t, function(){ dragging = false; });
    });
    box.addEventListener('touchstart', function(e){
      if (e.touches.length === 2) {
        dragging = false;
        var a = e.touches[0], b = e.touches[1];
        var rect = box.getBoundingClientRect();
        pinch = {
          d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
          z: view.z,
          mx: (a.clientX + b.clientX) / 2 - rect.left,
          my: (a.clientY + b.clientY) / 2 - rect.top,
        };
        e.preventDefault();
      }
    }, { passive: false });
    box.addEventListener('touchmove', function(e){
      if (!pinch || e.touches.length !== 2) return;
      var a = e.touches[0], b = e.touches[1];
      var d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
      zoomAround(pinch.z + Math.log(d / pinch.d) / Math.LN2, pinch.mx, pinch.my);
      e.preventDefault();
    }, { passive: false });
    box.addEventListener('touchend', function(e){ if (e.touches.length < 2) pinch = null; });
    box.addEventListener('wheel', function(e){
      e.preventDefault();
      var rect = box.getBoundingClientRect();
      zoomAround(view.z + (e.deltaY < 0 ? 0.5 : -0.5), e.clientX - rect.left, e.clientY - rect.top);
    }, { passive: false });
    var lastTap = 0;
    box.addEventListener('click', function(e){
      var now = Date.now();
      if (now - lastTap < 320 && moved < 12) {
        var rect = box.getBoundingClientRect();
        zoomAround(view.z + 1, e.clientX - rect.left, e.clientY - rect.top);
      }
      lastTap = now;
    });
    window.addEventListener('resize', function(){ render(); });

    fit();
    render();
    window.__mapView = function(){ return { z: view.z, lat: view.lat, lon: view.lon, tiles: Object.keys(pool).length }; };
    window.__amapMode = false;
    markReady();
  }

  function boot(){
    try {
      if (D.embed || !(D.pts || []).length) { drawStatic(); }
      else if (window.AMap) { initAmap(); }
      else { reportDiag('amap-missing', {}); drawTiles(); }
    } catch (e) {
      reportDiag('amap-throw', { msg: String((e && e.message) || '').slice(0, 120) });
      try { drawTiles(); } catch (e2) { try { drawStatic(); } catch (e3) { try { markReady(); } catch (e4) {} } }
    }
  }
  //  D-195：高德脚本改成 async（不再阻塞 <head>，文字/统计先画出来），所以这里必须等它就绪。
  //  等不到不是错误 —— 直接走自研瓦片兜底（这条路 D-158 起就一直在）。
  //  实测（4G 节流）：阻塞 FCP 4,480 ms → async+等就绪约 2,800~3,300 ms；纯 async 不加等待会把地图弄丢（canvas 0）。
  if (D.embed || !(D.pts || []).length) { boot(); }
  else {
    var __amapT0 = Date.now();
    (function waitAmap(){
      if (window.AMap || Date.now() - __amapT0 > 2500) { boot(); return; }
      setTimeout(waitAmap, 60);
    })();
  }
  setTimeout(markReady, D.embed ? 9000 : 3000);
})();
</script>
</body></html>`;
}

/** 地址去省市前缀：卡片与分享页共用同一套规则（D-148），只留「示例区示例街道…」这种能定位的部分 */
function shortAddr(loc) {
  const t = String(loc || "").trim();
  if (!t) return "—";
  return t.replace(/^.{2,6}省(?=.{2,})/, "").replace(/^.{2,6}市(?=.{2,})/, "").replace(/^\s+/, "") || t;
}

function notFound(msg) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<body style="margin:0;background:#0f1419;color:#e8eef5;font:16px -apple-system,system-ui;padding:40px 24px">` +
      `<h2 style="margin:0 0 8px">链接无效或已过期</h2><p style="color:#8ea0b4;margin:0">${esc(msg)}</p></body>`,
    { status: 404, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

export async function handleTripShare(request, env, url) {
  const p = url.pathname;
  const embed = url.searchParams.get("embed") === "1";
  const isBg = p.endsWith("/bg.png");
  const isRoutePng = p.endsWith("/route.png");
  const token = p
    .replace(/^\/t\//, "")
    .replace(/\/tile\/\d+\/\d+\/\d+\.png$/, "")
    .replace(/\/(bg|route)\.png$/, "")
    .replace(/\/diag$/, "")
    .replace(/\/$/, "");
  const v = await verifyTripToken(env, token);
  if (!v) return notFound("签名校验失败，或链接已过期。");

  // ── D-160：分享页地图真机诊断上报（白屏时用来定位到底哪一步失败）
  if (/\/diag$/.test(p)) {
    try {
      const q = url.searchParams;
      const rec = {};
      for (const [k2, v2] of q) rec[String(k2).slice(0, 12)] = String(v2).slice(0, 400);
      rec.at = new Date().toISOString();
      const prev = await db.getState(env.DB, "mapdiag", []);
      const list = Array.isArray(prev) ? prev.slice(-7) : [];
      list.push(rec);
      await db.setState(env.DB, "mapdiag", list);
    } catch { /* 诊断失败不影响页面 */ }
    return new Response("ok", { headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
  }

  // ── D-159：高德栅格瓦片代理。分享页的交互地图由我们自己渲染（见页面脚本），
  //    瓦片仍来自高德（style=7 道路图，含路名与 POI），从我们域名出 → 手机上不会被
  //    第三方图片策略拦掉（D-156 真机黄屏的直接原因就是外域瓦片取不到）。
  const tm = p.match(/\/tile\/(\d+)\/(\d+)\/(\d+)\.png$/);
  if (tm) {
    const tz = Number(tm[1]), tx = Number(tm[2]), ty = Number(tm[3]);
    const lim = Math.pow(2, tz);
    if (!(tz >= 3 && tz <= 18) || !(tx >= 0 && tx < lim) || !(ty >= 0 && ty < lim)) {
      return new Response("bad tile", { status: 400 });
    }
    const cacheKey = new Request(`https://amaptile.internal/${tz}/${tx}/${ty}.png`);
    const cache = typeof caches !== "undefined" && caches.default ? caches.default : null;
    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    }
    const sub = (tx + ty) % 4 + 1;
    const tileUrl = `https://wprd0${sub}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&style=7&x=${tx}&y=${ty}&z=${tz}`;
    const r = await fetch(tileUrl, {
      headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://www.amap.com/" },
      signal: AbortSignal.timeout(8000),
    });
    const ct = r.headers.get("Content-Type") || "";
    if (!r.ok || !ct.startsWith("image/")) {
      return new Response("tile unavailable", { status: 502, headers: { "Cache-Control": "no-store" } });
    }
    const out = new Response(r.body, {
      headers: { "Content-Type": ct, "Cache-Control": "public, max-age=604800", "X-Robots-Tag": "noindex" },
    });
    if (cache) { try { await cache.put(cacheKey, out.clone()); } catch {} }
    return out;
  }

  if (isBg) {
    const z = Number(url.searchParams.get("z"));
    const cx = Number(url.searchParams.get("cx"));
    const cy = Number(url.searchParams.get("cy"));
    if (!Number.isFinite(z) || z < 3 || z > 17 || !Number.isFinite(cx) || !Number.isFinite(cy)) {
      return new Response("bad params", { status: 400 });
    }
    try {
      //  D-156：s=2 出 2 倍图给 retina 手机（Amap 静态图单边最大 1024，所以尺寸减半 + scale=2）
      const hi = url.searchParams.get("s") === "2";
      const img = await fetchStaticMap(env, {
        center: { lat: cy, lon: cx }, zoom: Math.round(z),
        w: hi ? Math.round(MAP_W / 2) : MAP_W, h: hi ? Math.round(MAP_H / 2) : MAP_H, scale: hi ? 2 : 1,
      });
      const headers = new Headers(img.headers);
      headers.set("Cache-Control", "private, max-age=604800");
      headers.set("X-Robots-Tag", "noindex");
      return new Response(img.body, { headers });
    } catch (err) {
      return new Response(`static map unavailable: ${err.message} | ${(err.body || "").slice(0, 300)} | ${err.url || ""}`, { status: 502 });
    }
  }

  if (isRoutePng) {
    // D-082：卡片里那张截图也单独存了一份到 R2，这里按签名令牌取回（面板/兜底用）
    const veh = await db.getVehicle(env.DB);
    if (!veh || !veh.vin || !env.MEDIA) return notFound("找不到这张线路图。");
    const obj = await env.MEDIA.get(`trip/${veh.vin}/${v.id}.png`);
    if (!obj) return notFound("这张线路图还没有生成。");
    return new Response(obj.body, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=86400",
        "X-Robots-Tag": "noindex",
      },
    });
  }

  const vehicle = await db.getVehicle(env.DB);
  if (!vehicle || !vehicle.vin) return notFound("尚未初始化车辆信息。");
  const trip = await db.getTripLog(env.DB, vehicle.vin, v.id);
  if (!trip) return notFound("找不到这条行程。");

  const points = parseRoute(trip.route_points);
  // embed 截图底部有渐变数据条（约 150px@640 宽），多留一点，别把路线压住
  const view = fitView(points, undefined, undefined, 46, 4, 17, embed ? 132 : 46);

  let cost = null;
  try {
    const usage = await db.getState(env.DB, "usage:price");
    const price = Number(usage && usage.price);
    const perPct = Number(usage && usage.kwh_per_pct) || 0.31;
    const pct = Math.abs((Number(trip.battery_from) || 0) - (Number(trip.battery_to) || 0));
    if (Number.isFinite(price) && price > 0 && pct > 0) {
      const kwh = pct * perPct;
      cost = { kwh, cny: kwh * price, price: price.toFixed(2), priceAt: (usage && usage.at) || "" };
    }
  } catch { /* 电价拿不到就不显示花费，不影响页面 */ }

  // 调试开关：?amapv=1.4 用 1.4.x（DOM 瓦片渲染器）对比 2.0（WebGL）在同一浏览器里的表现（D-084）
  // 默认 1.4.x：2.0 走 WebGL 渲染，在部分浏览器里瓦片贴图失败 → 整张地图全黑（D-084 实测）
  const amapv = url.searchParams.get("amapv") === "2.0" ? "2.0" : "1.4.15";
  //  D-200：embed（卡片截图）用的底图在【服务端】取好、base64 内联进 HTML，
  //    截图页零外部请求 —— 否则浏览器还要再请求一次同域 /bg.png，Worker 再回头调高德，
  //    在 Browser Rendering 冷启动里这一跳经常来不及，截出来就是「黑底 + 一条蓝折线」。
  let embedBg = "";
  if (embed) {
    try {
      const img = await fetchStaticMap(env, {
        center: { lat: view.center.lat, lon: view.center.lon }, zoom: Math.round(view.zoom),
        w: Math.round(MAP_W / 2), h: Math.round(MAP_H / 2), scale: 2,
      });
      const buf = new Uint8Array(await img.arrayBuffer());
      if (buf.length) {
        let bin = "";
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        const ct = String(img.headers.get("Content-Type") || "image/png").split(";")[0].trim() || "image/png";
        embedBg = `data:${ct};base64,${btoa(bin)}`;
      }
    } catch (err) {
      console.log("embed 底图内联失败，回退 bg.png:", err.message);
    }
  }

  const body = html({
    trip: { ...trip, __token: token }, points, view, cost, tokenExp: v.exp, embed, embedBg, amapv,
    carName: vehicle.nickname || "",
  });
  return new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
    },
  });
}
