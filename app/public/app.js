/* 理想助手 · Web 面板 */
const $ = (s) => document.querySelector(s);
const fmt = (v, u = "", d = 1) =>
  (v === null || v === undefined || Number.isNaN(Number(v))) ? "--" : `${Number(v).toFixed(d)}${u}`;
const money = (v) => (v === null || v === undefined) ? "--" : `¥${Number(v).toFixed(2)}`;

// 数值 → 字符串：空值统一 "--"（不得出现 --% / NaN，D-096 §4）
const num = (v, d = 0) =>
  (v === null || v === undefined || Number.isNaN(Number(v))) ? "--" : Number(v).toFixed(d);
// 小数位按「有没有小数」自动裁：209 → "209"，214.5 → "214.5"
const numA = (v) => {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "--";
  const n = Number(v);
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
};
// "2026-11-06 14:16:21" / ISO → "14:16"
const hhmm = (t) => {
  const m = String(t || "").match(/(\d{1,2}:\d{2})/);
  return m ? m[1].padStart(5, "0") : "";
};
// 第 3 参是「单位」：数字与单位之间由 CSS margin 控制，调用方不要自己拼空格
function metric(label, value, unit) {
  const u = unit ? String(unit).trim() : "";
  return `<div class="m"><div class="l">${label}</div><div class="v">${value}${u ? `<small>${u}</small>` : ""}</div></div>`;
}
// 往已有 <small> 单位的结构里只换数值
function kv(sel, val, unit) {
  const el = $(sel);
  if (!el) return;
  el.innerHTML = `${val}${unit ? `<small>${unit}</small>` : ""}`;
}

// 折叠态标题行上的「标题数字」（D-189）：
// 只写一个与该卡正文**不重复**的头条数字，让收起时仍能一眼看到结论（基线 §2.2）。
// 写空字符串 = 该卡折叠后不显示任何数字（避免和页头徽标重复）。
function meta(sel, text) {
  const el = $(sel);
  if (el) el.textContent = text || "";
}

// 令牌：优先 URL 上的 ?k=（首次访问 / PWA 添加后回访），否则用 cookie
const _url = new URL(location.href);
if (_url.searchParams.get("k")) {
  localStorage.setItem("li_token", _url.searchParams.get("k"));
  history.replaceState(null, "", location.pathname);
}
const TOKEN = localStorage.getItem("li_token") || "";

async function get(path) {
  const r = await fetch(path, {
    credentials: "same-origin",
    headers: TOKEN ? { "X-API-Token": TOKEN } : {},
  });
  if (r.status === 401) { location.href = "/login"; return null; }
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

async function post(path, body) {
  const r = await fetch(path, {
    method: "POST", credentials: "same-origin",
    headers: {
      ...(TOKEN ? { "X-API-Token": TOKEN } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.status === 401) { location.href = "/login"; return { ok: false, error: "未登录" }; }
  // 非 JSON（500/网关错误）也要给调用方一个可读错误，否则报 "Unexpected token" 没法定位
  try { return await r.json(); } catch { return { ok: false, error: `HTTP ${r.status}` }; }
}

async function loadStatus() {
  const d = await get("/api/status");
  if (!d) return;
  const v = d.vehicle || {};
  const s = d.sample || {};
  const dt = s.detail || {};
  const b = s.battery;

  // ── 头部：车型 · 车牌（采样时刻只在「实时状态」卡出现一次，基线 §2.2）──
  $("#vname").textContent = v.nickname || v.spu || "理想助手";
  const at = hhmm(s.sampled_at);
  $("#vsub").textContent = [v.spu, v.plate_no].filter(Boolean).join(" · ") || "加载中…";
  $("#updated").textContent = at ? `${at} 更新` : "—";

  // ── Hero：电量环 + 三续航 ──
  $("#batt").textContent = b === null || b === undefined ? "--" : Math.round(b);
  const C = 326.7;
  $("#ring").setAttribute("stroke-dashoffset", String(C - (C * (b || 0)) / 100));
  $("#ring").setAttribute("stroke", s.charging ? "var(--accent)" : "var(--green)");
  kv("#hero_re", num(dt.range_elec, 0), "km");
  kv("#hero_rf", num(dt.range_fuel, 0), "km");
  // 综合续航 = 纯电 + 燃油（增程口径，D-097 补记）；任一缺值就显示 --
  const _re = Number(dt.range_elec), _rf = Number(dt.range_fuel);
  kv("#hero_rc", Number.isFinite(_re) && Number.isFinite(_rf) ? Math.round(_re + _rf) : null, "km");
  kv("#hero_fuel", num(dt.fuel_level, 0), "%");

  // ── 状态胶囊：行驶 / 充电 / 哨兵（文字优先，颜色只做语义）──
  const pills = [];
  const trav = dt.travel_status_text || "--";
  pills.push(`<span class="pill ${/行驶|驾驶|行进|运行/.test(trav) ? "g" : "grey"}">${trav}</span>`);
  const chg = dt.charge_status_text || (s.charging ? "充电中" : "未充电");
  pills.push(`<span class="pill ${s.charging ? "g" : "grey"}">${chg}</span>`);
  if (dt.sentinel_text) pills.push(`<span class="pill grey">哨兵 ${dt.sentinel_text}</span>`);
  $("#pills").innerHTML = pills.join("");

  // ── 主指标 4 项（续航/油量已在 Hero，这里不重复）──
  $("#g1").innerHTML = [
    metric("总里程", num(d.trip?.mileage_km, 0), "km"),
    metric("车速", num(s.speed, 0), "km/h"),
    metric("车内温度", num(s.indoor_temp, 1), "℃"),
    metric("电池包电压", num(dt.pack_voltage, 1), "V"),
  ].join("");

  // ── 胎压条：单位只在表头出现一次 ──
  const t2 = dt.tires || {};
  const order = ["左前", "右前", "左后", "右后"];
  const tks = order.filter((k) => k in t2).concat(Object.keys(t2).filter((k) => !order.includes(k)));
  $("#tires").innerHTML = `<div class="cap"><span>胎压</span><span>kPa</span></div>` +
    (tks.length
      ? tks.map((k) => `<div class="c"><span>${k}</span><b>${numA(t2[k])}</b></div>`).join("")
      : `<div class="c"><span>胎压</span><b>--</b></div>`);

  // ── 折叠：不常用但偶发要查的 5 项 ──
  $("#g1b").innerHTML = [
    metric("空调设定", num(dt.ac_set_temp, 1), "℃"),
    metric("行驶状态", trav),
    metric("充电状态", chg),
    metric("哨兵", dt.sentinel_text || "--"),
    metric("OTA 版本", dt.ota_version || "--"),
  ].join("");

  // ── 车机行程表 · 智驾（累计口径，来自车机 trip_total）──
  const t = d.trip || {};
  $("#g2").innerHTML = [
    metric("纯电里程", num(t.cd_km, 0), "km"),
    metric("发动机里程", num(t.engine_km, 0), "km"),
    metric("智驾里程", num(t.ad_km, 0), "km"),
    metric("NOA 里程", num(t.noa_km, 0), "km"),
    metric("LCC 里程", num(t.lcc_km, 0), "km"),
    metric("ACC 里程", num(t.acc_km, 0), "km"),
    metric("辅助驾驶天数", num(t.ad_days, 0), "天"),
    metric("城区 NOA", num(t.city_noa_days, 0), "天"),
  ].join("");
  // 折叠态标题行：智驾累计里程 + 辅助驾驶天数（与正文指标不同口径：正文是 6 类里程明细）
  meta("#m-ad", `智驾 ${num(t.ad_km, 0)} km · ${num(t.ad_days, 0)} 天`);

  // ── 采集健康 ──
  const bad = (d.health || []).filter((h) => !h.ok);
  const badge = $("#hbadge");
  if (bad.length) { badge.className = "badge bad"; badge.textContent = `采集异常 ${bad.length}`; }
  else { badge.className = "badge ok"; badge.textContent = "正常"; }

  // 折叠态标题行：只写「几项检查」，正常/异常由页头徽标承担，不重复
  meta("#m-health", `${(d.health || []).length} 项检查`);

  $("#hl").innerHTML = (d.health || []).map((h) =>
    `<div><span>${h.kind}</span><span>${h.ok ? "正常" : "异常"} · ${h.last_ok_at || "—"}${h.last_error ? " · " + h.last_error.slice(0, 60) : ""}</span></div>`
  ).join("") || "<div><span>暂无</span><span>—</span></div>";
}

async function loadDaily() {
  const d = await get("/api/daily?days=14");
  if (!d) return;
  const rows = d.rows || [];
  const max = Math.max(1, ...rows.map((r) => Number(r.travel_km || 0)));
  const bars = $("#bars");
  if (!bars) return;
  bars.innerHTML = rows.map((r, i) =>
    `<span class="bcol" data-i="${i}" title="${r.stat_date} · ${r.travel_km} km">` +
    `<i style="height:${Math.max(2, (Number(r.travel_km || 0) / max) * 88)}px"></i></span>`
  ).join("");
  $("#b0").textContent = rows.length ? rows[0].stat_date : "—";
  $("#b1").textContent = rows.length ? rows[rows.length - 1].stat_date : "—";

  // D-190：柱图读数。手机没有 hover，title 看不到 → 点柱子把数值写到下方读数条。
  // 默认显示窗口内最高的一天（带「最高」前缀，避免被误读成「今天」）。
  const read = $("#barread");
  if (read && rows.length) {
    const peak = rows.reduce((a, r, i) => (Number(r.travel_km || 0) > Number(rows[a].travel_km || 0) ? i : a), 0);
    const paint = (i, isPeak) => {
      bars.querySelectorAll(".bcol").forEach((el, k) => el.classList.toggle("on", k === i));
      const r = rows[i];
      const km = Number(r.travel_km || 0);
      read.innerHTML = `${isPeak ? "最高 " : ""}${String(r.stat_date || "").slice(5)} · <b>${km.toFixed(1)} km</b>`;
    };
    bars.onclick = (e) => {
      const col = e.target.closest(".bcol");
      if (col && col.dataset.i != null) paint(Number(col.dataset.i), false);
    };
    paint(peak, true);
  }

  // 折叠态标题行：14 天总里程（柱图本身不给总数，这里补一个）
  const sum14 = rows.reduce((a, r) => a + (Number(r.travel_km) || 0), 0);
  meta("#m-days", rows.length ? `${rows.length} 天 · ${sum14.toFixed(0)} km` : "—");
}

async function loadMonth() {
  const d = await get("/api/month");
  if (!d) return;
  const s = d.summary || {};
  // D-190：标出具体月份。截图/回看时「本月」指代不清（用户反馈），一律写成「11 月」。
  const mon = String(d.month || "");
  const ml = mon.length >= 7 ? `${Number(mon.slice(5, 7))} 月` : "本月";
  $("#g3").innerHTML = [
    metric(`${ml}里程`, fmt(s.travel_km, " km", 0)),
    metric("纯电占比", fmt(s.pure_ratio, " %", 0)),
    metric("耗电", fmt(s.elec_kwh, " kWh", 1)),
    metric("油耗", fmt(s.fuel_l, " L", 1)),
    metric("电费", money(s.cost_cny)),
    metric("油费", money(s.fuel_cost_cny)),
    metric("合计", money(s.total_cost)),
    metric("充电量", fmt(s.charge_kwh, " kWh", 1)),
  ].join("");
  // 折叠态标题行：月份 + 里程 + 合计花费（正文是 8 项分项，这里给一个总数）
  meta("#m-month", `${ml} · ${num(s.travel_km, 0)} km · ${money(s.total_cost)}`);
}

async function loadBills() {
  const d = await get("/api/bills");
  if (!d) return;
  const s = d.summary || {};
  const CT = { 1: "DC 快充", 2: "AC 慢充", 3: "5C 超充", 4: "理想超充" };
  $("#billsum").innerHTML = [
    metric("本月充电", s.sessions ?? 0, " 次"),
    metric("充入电量", fmt(s.kwh, " kWh", 1)),
    metric("电费", money(s.cost)),
    metric("平均单价", s.avg_price === null || s.avg_price === undefined ? "--" : `¥${Number(s.avg_price).toFixed(3)}`),
  ].join("");
  // 折叠态标题行：次数 + 电量 + 电费（正文里这三项是分开的，这里合成一句）
  meta("#m-bill", `${s.sessions ?? 0} 次 · ${num(s.kwh, 1)} kWh · ${money(s.cost)}`);

  const rows = d.rows || [];
  if (!rows.length) {
    $("#chg").innerHTML = `<div class="err">${d.month || ""} 暂无充电记录</div>`;
    return;
  }
  const BAND = { "谷时": "g", "峰时": "a", "平时": "" };
  $("#chg").innerHTML = `<table><thead><tr><th>开始</th><th>类型</th><th>电量</th><th>单价</th><th>电费</th></tr></thead><tbody>` +
    rows.map((r) => `<tr>
      <td>${(r.started_at || "").slice(5, 16)}</td>
      <td><span class="pill ${r.charging_type === 1 || r.charging_type === 3 || r.charging_type === 4 ? "g" : "a"}">${CT[r.charging_type] || "—"}</span></td>
      <td>${fmt(r.capacity_kwh, " kWh", 1)}</td>
      <td>${r.price_per_kwh === null || r.price_per_kwh === undefined ? "—" : `¥${Number(r.price_per_kwh).toFixed(2)}${r.band ? ` <span class="pill ${BAND[r.band] || ""}">${r.band}</span>` : ""}`}</td>
      <td>${money(r.cost_cny)}</td></tr>`).join("") +
    `</tbody></table>`;
  if (s.by_type && Object.keys(s.by_type).length) {
    const parts = Object.entries(s.by_type).map(([t, v]) =>
      `${CT[t] || "类型" + t} ${v.sessions} 次 ${Number(v.kwh).toFixed(1)} kWh ${money(v.cost)}`);
    $("#chg").innerHTML += `<div class="legend" style="margin-top:8px;display:block">${parts.join("　·　")}</div>`;
  }
}

// ── 行程与线路图（D-076：Worker 纠偏出点列，前端 JS API 画真折线）──
let _tripMap = null;
let _tripOverlay = [];

// D-190：原来固定只取 12 条且标题写「12 次」，看着像「一共就只有 12 次」。
// 改成取全量（API 上限 200）用于计数与合计，表格默认仍只铺 12 行，其余点「显示全部」展开。
const TRIPS_SHOW = 12;

async function loadTrips() {
  let d;
  try { d = await get("/api/trips?limit=200"); } catch { return; }
  const all = (d && d.rows) || [];
  const sum = (k) => all.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const kmAll = sum("distance_km"), elecAll = sum("elec_km"), adAll = sum("ad_km");
  const box = $("#tripsum");
  if (box) {
    box.innerHTML = [
      metric("累计行程", `${all.length}`, " 次"),
      metric("合计里程", fmt(kmAll, "", 1), " km"),
      metric("其中纯电", fmt(elecAll, "", 1), " km"),
      metric("智驾", fmt(adAll, "", 1), " km"),
    ].join("");
  }
  // 折叠态标题行：总次数 + 总里程（不是「列表里铺了几行」）
  meta("#m-trip", all.length ? `${all.length} 次 · ${kmAll.toFixed(0)} km` : "暂无记录");
  const list = $("#trips");
  if (!list) return;
  if (!all.length) { list.innerHTML = `<div class="hint">还没有记录到行程。开车 6 分钟后会自动生成行程小结。</div>`; return; }
  // D-190 / P0-2：六列表格改两行式卡片，按钮固定在行内，不再被横向滚动藏起来
  const tr = (r, i) => {
    const km = Number(r.distance_km) || 0;
    const ec = Number(r.elec_km) || 0;
    const bits = [(r.started_at || "").slice(5, 16)];
    if (r.duration_min) bits.push(`${r.duration_min} 分`);
    // 混动行程才标注纯电里程，纯电行程它是同义重复（基线 §2.2）
    if (km - ec > 0.5) bits.push(`纯电 ${ec.toFixed(1)}`);
    const place = placePair(r.start_loc, r.end_loc);
    return `<div class="trow"${i >= TRIPS_SHOW ? ' data-more="1" style="display:none"' : ""}>
      <div class="tmain">
        <div class="tl1"><b>${km.toFixed(1)} km</b><span>${bits.join(" · ")}</span></div>
        <div class="tl2">
          <div class="tla">${place[0]}</div>
          <div class="tlb"><span class="arw">→</span>${place[1]}</div>
        </div>
      </div>
      <button class="btn ghost" onclick="showTrip(${r.id})">看线路</button>
    </div>`;
  };
  list.innerHTML = `<div class="tlist">${all.map(tr).join("")}</div>` +
    (all.length > TRIPS_SHOW
      ? `<button class="btn ghost" id="tripmore" style="margin-top:10px;width:100%" onclick="showAllTrips(this)">显示全部 ${all.length} 次</button>`
      : "");
}

/** 展开列表里被折叠的其余行程（D-190） */
function showAllTrips(btn) {
  document.querySelectorAll('#trips .trow[data-more]').forEach((el) => {
    el.style.display = "";
    el.removeAttribute("data-more");
  });
  if (btn) btn.remove();
}

function shortPlace(v) {
  if (!v) return "未记录地点";
  let s = String(v).trim();
  // D-190：原始坐标直接显示在界面上既难读也等于公开位置，统一折叠掉
  if (/^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(s)) return "未记录地点";
  // 去掉省/市前缀，只留区县+街道；手机一行放不下全称，会被 ellipsis 吃掉
  s = s.replace(/^.{2,5}?(省|自治区|特别行政区)/, "").replace(/^.{2,5}?(市|自治州|地区)/, "");
  return s || String(v);
}

/** 起终点成对处理（D-191）
 *  绝大多数行程起终点在同一街道（如「示例区示例街道」7 字），逐字重复占掉
 *  半行宽 —— 基线 §2.2 同一信息只出现一次。这里把公共前缀从终点里去掉：
 *  起点完整显示，终点只留差异部分，通常就能压回一行。
 *  护栏：公共前缀 ≥4 字且终点剩余 ≥4 字才裁，避免裁成空串或看不懂。 */
function placePair(a, b) {
  const s = shortPlace(a);
  let e = shortPlace(b);
  if (s === "未记录地点" || e === "未记录地点") return [s, e];
  // 起终点同一地址（往返/原地挪车），终点再写一遍就是纯重复
  if (s === e) return [s, "同一地点"];
  let i = 0;
  while (i < s.length && i < e.length && s[i] === e[i]) i++;
  // 只在地名分段边界上裁（D-191）。纯逐字裁会把「示例乡」切成「例乡」——
  // 读起来像新乡市，比不裁更糟。往回退到最近的边界字再裁。
  const BOUND = "道街乡镇路区县村巷号里苑厦城场站园桥门";
  let j = i;
  while (j > 0 && !BOUND.includes(s[j - 1])) j--;
  // 「示例路」+「辅路示例小区」这种：裁完剩「辅路示例小区」读不通，
  // 改为越过这个边界（裁到「示例路辅路」），只留真正的目的地
  if (/^[辅主支上下侧前后]/.test(e.slice(j))) {
    let k = j + 1;
    while (k < e.length && !BOUND.includes(e[k])) k++;
    if (k < e.length) j = k + 1;
  }
  if (j >= 4 && e.length - j >= 4) e = e.slice(j);
  return [s, e];
}

/* 高德 JS API 按需加载（D-192）
   首屏完全用不到地图：全站只有 #tripmap 一个容器，只有点「看线路」才画线。
   改前它是 <body> 末尾的普通 script，浏览器要下完 114 KB 主包 + 高德再自拉 49 KB 模块，
   才轮到 /app.js 执行 —— 6 个数据接口实测被推到 2.3 s，占整页字节 86.9%，
   换的却是默认不显示的一张图。实测 defer 无效（deferred 脚本按文档顺序执行，
   app.js 照样等高德），所以直接改成点击时注入。 */
const AMAP_SRC = "https://webapi.amap.com/maps?v=1.4.15&key=YOUR_AMAP_JS_KEY&plugin=AMap.Scale,AMap.ToolBar";
let _amapP = null;
function loadAmap() {
  if (typeof window.AMap !== "undefined") return Promise.resolve(true);
  if (_amapP) return _amapP;
  _amapP = new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = AMAP_SRC;
    s.async = true;
    s.onload = () => resolve(typeof window.AMap !== "undefined");
    s.onerror = () => { _amapP = null; resolve(false); }; // 允许下次点击重试
    document.head.appendChild(s);
  });
  return _amapP;
}
/** 高德加载超时兜底：不能因为第三方慢就永远停在「加载中」 */
function raceTimeout(p, ms) {
  return Promise.race([p, new Promise((r) => setTimeout(() => r("timeout"), ms))]);
}

async function showTrip(id) {
  const wrap = $("#tripmapwrap");
  const el = $("#tripmap");
  if (!wrap || !el) return;
  wrap.style.display = "block";
  // D-190：地图开在 12 行表格下方（实测距视口顶部 1320px，视口只有 844px），
  // 屏幕上看不到任何变化，用户以为「看路线」按钮没反应（线上反馈）。
  // 打开后主动滚进视口；已经在视口内就不动，避免桌面端无谓跳动。
  const reveal = () => {
    const r = wrap.getBoundingClientRect();
    const vh = window.innerHeight || 0;
    if (r.top < 0 || r.bottom > vh) wrap.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  requestAnimationFrame(reveal);
  $("#tripmapname").textContent = "线路加载中…";
  // 与 /api/trips/:id 并行，别串行等：地图下载 1.3s + 接口 0.5s 串起来就是 1.8s
  const mapP = loadAmap();
  // 占位要盖在瓦片上：等首帧渲染完（complete）再撤，否则中间会闪一下黑底
  if (!_tripMap) {
    el.innerHTML = `<div id="tripmapmsg" style="position:absolute;inset:0;display:flex;align-items:center;
      justify-content:center;color:#8a8f98;font-size:13px;pointer-events:none;background:#111;z-index:2">正在加载地图…</div>`;
  }
  let d;
  try { d = await get(`/api/trips/${id}`); } catch { $("#tripmapname").textContent = " 读取失败"; return; }
  const pts = (d.route_points || []).map((p) => [p[0], p[1]]);
  $("#tripmapname").textContent =
    `${(d.started_at || "").slice(5, 16)} · ${fmt(d.distance_km, " km", 1)}` +
    (d.route_km ? ` · 道路 ${d.route_km.toFixed(1)} km` : "") +
    (d.route_source === "raw" ? "（车机采样轨迹）" : "");

  // D-192：地图改成点按时才下载，这里必须真的等它，并给超时兜底
  const mapOk = await raceTimeout(mapP, 15000);
  if (mapOk !== true) {
    el.innerHTML = `<div style="padding:24px;color:var(--dim);font-size:13px">
      ${mapOk === "timeout" ? "地图加载超时" : "地图加载失败"}（网络较慢或高德不可用），再点一次「看线路」会重试。
      文字摘要：${(d.started_at || "").slice(5, 16)} · ${fmt(d.distance_km, " km", 1)}${
        d.route_source === "raw" ? "（车机采样轨迹）" : ""}</div>`;
    $("#tripmapname").textContent = "线路图未加载";
    return;
  }
  if (!pts.length) {
    el.innerHTML = `<div style="padding:24px;color:#8a8f98;font-size:13px">这条行程没有存下线路点（采样不足或建线失败：${d.route_error || "无"}）。</div>`;
    return;
  }
  if (!_tripMap) {
    _tripMap = new window.AMap.Map(el, { zoom: 14, resizeEnable: true, mapStyle: "amap://styles/dark" });
    // D-192 占位撤除时机：首帧渲染完成（complete）再撤；兜底 2.5s 强制撤，别一直挡着
    const hideMsg = () => { const m = document.getElementById("tripmapmsg"); if (m) m.remove(); };
    _tripMap.on("complete", () => setTimeout(hideMsg, 150));
    setTimeout(hideMsg, 2500);
  }
  _tripOverlay.forEach((o) => o.setMap && o.setMap(null));
  _tripOverlay = [];
  // 注意：AMap 1.4 的 Polyline 会**就地改写** path 数组（把 [lng,lat] 换成 LngLat 对象），
  // 所以 bbox 必须在建 Polyline 之前算好，且传给它的要用副本（D-084 踩坑）。
  const lngs = pts.map((p) => p[0]), lats = pts.map((p) => p[1]);
  const sw = [Math.min(...lngs), Math.min(...lats)];
  const ne = [Math.max(...lngs), Math.max(...lats)];
  const span = Math.max(ne[0] - sw[0], ne[1] - sw[1]);

  const poly = new window.AMap.Polyline({
    path: pts.map((p) => [p[0], p[1]]), strokeColor: "#4f8cff", strokeWeight: 6, strokeOpacity: 0.9,
    lineJoin: "round", lineCap: "round", showDir: true,
  });
  // D-194：换暗色底图后，AMap 默认的蓝色图钉 + label 白底白字（label 继承页面 --fg，
  // 在白底上几乎看不见）在暗底上很扎眼；改成与分享页一致的自绘圆点胶囊。
  const mk = (t, cls) => `<div class="mk ${cls}"><i></i>${t}</div>`;
  // 起点标签往上、终点标签往下错开 15px：两点相距几十米时（城市内很常见）不叠在一起
  const start = new window.AMap.Marker({ position: pts[0], content: mk("起点", "mk-a"), anchor: "center", offset: new window.AMap.Pixel(0, -15), zIndex: 110 });
  const end = new window.AMap.Marker({ position: pts[pts.length - 1], content: mk("终点", "mk-b"), anchor: "center", offset: new window.AMap.Pixel(0, 15), zIndex: 111 });
  _tripMap.add([poly, start, end]);
  _tripOverlay = [poly, start, end];

  // 视口自适应：自己算 bbox（不依赖 poly.getBounds()），并在 complete 之后再调
  // —— AMap 1.4 的 setBounds 在地图首帧渲染完成前会被忽略，只调一次就会停在默认中心（北京）。
  const fit = () => {
    if (!_tripMap) return;
    // 用 setFitView 而不是 setBounds：1.4 里 setBounds + Bounds 组合会抛 Pixel(NaN, NaN)（实测）
    try {
      if (span < 1e-4) _tripMap.setZoomAndCenter(16, [pts[0][0], pts[0][1]]);
      else _tripMap.setFitView([poly], false, [70, 70, 70, 70]);
    } catch (e) {
      _tripMap.setZoomAndCenter(15, [pts[0][0], pts[0][1]]);
    }
  };
  fit();
  if (!_tripMap.__fitBound) {
    _tripMap.__fitBound = true;
    _tripMap.on("complete", () => setTimeout(fit, 60));
  }
  setTimeout(fit, 350);
  setTimeout(fit, 1200);
}

function closeTripMap() {
  const wrap = $("#tripmapwrap");
  if (wrap) wrap.style.display = "none";
}

async function loadSchedule() {
  const d = await get("/api/schedule");
  if (!d) return;
  const rows = d.tasks || [];
  const now = String(d.server_time || "").slice(5, 16);
  $("#sched").innerHTML =
    `<div class="rows" style="margin-bottom:10px">
       <div><span>服务器时间</span><span>${now} (${d.timezone})</span></div>
       <div><span>今日已推送</span><span>${d.today_count ?? 0} 条</span></div>
       <div><span>推送目标</span><span>${d.target ? d.target.type + " = " + String(d.target.id).slice(0, 14) + "…" : "未绑定"}</span></div>
     </div>` +
    `<table><thead><tr><th>任务</th><th>节奏</th><th>窗口</th><th>下次</th></tr></thead><tbody>` +
    rows.map((t) => `<tr>
      <td>${t.label}</td><td>${t.cadence}</td><td>${t.window}</td>
      <td>${t.kind === "collect" ? "下一分钟" : (t.next || "").slice(5, 16)}</td></tr>`).join("") +
    `</tbody></table>`;

  const recent = d.recent || [];
  $("#schedmsg").innerHTML = recent.length
    ? "最近推送：" + recent.slice(0, 5).map((r) => `${String(r.sent_at || "").slice(5, 16)} ${String(r.event_key || "").split(":").slice(0, 2).join(":")}`).join(" · ")
    : "";
  // 折叠态标题行：只写服务器时间。
  // 「今日已推送 N 条」正文里已有，写这里就是同一信息出现两次（基线 §2.2）。
  meta("#m-sched", now ? `服务器 ${now}` : "—");
}

async function pushNow(kind) {
  $("#schedmsg").textContent = "推送中…";
  const d = await post("/api/push", { kind });
  $("#schedmsg").textContent = d && d.ok
    ? ` 已推送 ${kind}（${d.key || ""}）`
    : ` ${(d && (d.error || d.msg)) || "失败"}`;
  loadSchedule();
}

async function collectNow() {
  $("#ops").innerHTML = '<span class="err">采集中…</span>';
  const d = await post("/api/collect");
  $("#ops").innerHTML = `<span class="err">完成：</span><span style="font-size:12px;color:var(--dim)">${JSON.stringify(d).slice(0, 240)}</span>`;
  setTimeout(loadAll, 800);
}

async function testPush() {
  // D-194（P1-7）：反馈原来写进 #ops（「操作」卡），而按钮在「飞书绑定」卡，手机上落差 340px 看不到任何反应。
  // 现在写到按钮旁边的 #fmsg，并把按钮禁用 1.2s 防连点；异常也要复位（P1-9 的同类问题）。
  const btn = $("#btntestpush"), msg = $("#fmsg");
  if (btn) btn.disabled = true;
  if (msg) msg.textContent = "推送中…";
  try {
    const d = await post("/api/test-push");
    if (msg) msg.textContent = d && d.ok ? `已推送（${d.kind || "ok"}）` : `失败：${(d && (d.error || d.msg)) || "未知"}`;
  } catch (e) {
    if (msg) msg.textContent = `失败：${String(e && e.message || e)}`;
  } finally {
    setTimeout(() => { if (btn) btn.disabled = false; }, 1200);
  }
}

// D-194（P2-17）：原来「刷新」走 location.reload()，手机滑到页面底部点一下直接回顶部，
// 而且要重跑 6 个请求 + 重下资源。改成只重取数据，滚动位置不动。
async function refreshAll() {
  const el = $("#ops");
  if (el) el.innerHTML = '<span class="hint">刷新中…</span>';
  await loadAll();
  if (el) el.innerHTML = '<span class="hint">已刷新（' + new Date().toLocaleTimeString("zh-CN", { hour12: false }).slice(0, 5) + '）</span>';
}

async function loadAll() {
  try { await Promise.all([loadStatus(), loadDaily(), loadMonth(), loadBills(), loadSchedule(), loadTrips()]); }
  catch (e) { console.error(e); }
}
loadAll();

// 飞书卡片里的「查看线路图」链接 → ?trip=<id> 直达
{
  const tp = new URL(location.href).searchParams.get("trip");
  if (tp) setTimeout(() => showTrip(tp), 900);
}
loadFeishu();
// D-194（P2-17）：hidden 时不发请求；回到前台按「最后一次成功刷新」决定要不要补。
let _lastTick = Date.now();
function tick(fn) { return () => { if (document.hidden) return; _lastTick = Date.now(); fn(); }; }
setInterval(tick(loadStatus), 60000);
setInterval(tick(loadSchedule), 60000);
setInterval(tick(loadFeishu), 60000);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  if (Date.now() - _lastTick > 120000) { _lastTick = Date.now(); loadStatus(); loadSchedule(); loadFeishu(); }
});

/** 车模：默认只用海报。
 *  桌面端点「3D」才按需加载 model-viewer + 675 KB GLB（建模会话产物，Draco）；
 *  失败/超时保留海报。手机端按钮与容器都隐藏，首屏不下载任何车图（D-096/D-099）。
 *  ?v= 是缓存键：/models/* 走 R2 且 immutable 一年，换模型必须改这个版本号，否则老用户拿旧文件。 */
let _car3dLoading = false;
function loadCar3D() {
  const box = document.getElementById("carmedia");
  const poster = document.getElementById("carposter");
  const btn = document.getElementById("car3d");
  if (!box || _car3dLoading || box.querySelector("#car")) return;
  _car3dLoading = true;
  if (btn) { btn.disabled = true; btn.textContent = "加载中"; }
  const done = (ok) => {
    _car3dLoading = false;
    if (btn) {
      if (ok) { btn.remove(); return; }
      btn.disabled = false;
      btn.textContent = "3D";
    }
  };
  const sc = document.createElement("script");
  sc.type = "module";
  sc.src = "https://unpkg.com/@google/model-viewer@3.5.0/dist/model-viewer.min.js";
  sc.onerror = () => done(false);
  sc.onload = () => {
    const mv = document.createElement("model-viewer");
    mv.id = "car";
    //  camera-orbit 只给角度、半径一律 auto：模型单位非真实米制，写死半径会取景失败（D-084 踩坑）
    //  field-of-view 18deg + az 35deg：288×168 里车体占宽约 70%，且与海报同为右前方 3/4 视角（D-099）
    const attrs = {
      src: "/models/car.glb?v=20261110b", "camera-controls": "", "auto-rotate": "",
      "rotation-per-second": "18deg", exposure: "1.1", "environment-image": "neutral",
      "shadow-intensity": "1", "field-of-view": "18deg", "interaction-prompt": "none",
      "camera-target": "auto", "camera-orbit": "35deg 72deg auto",
      "min-camera-orbit": "auto 60deg auto", "max-camera-orbit": "auto 110deg auto",
    };
    Object.entries(attrs).forEach(([k, val]) => mv.setAttribute(k, val));
    let ok = false;
    mv.addEventListener("load", () => {
      ok = true;
      mv.classList.add("in");
      if (poster) poster.style.display = "none";
      done(true);
    });
    setTimeout(() => {
      if (!ok) {
        mv.remove();
        if (poster) poster.style.display = "block";
        done(false);
      }
    }, 12000);
    box.appendChild(mv);
  };
  document.head.appendChild(sc);
}
document.getElementById("car3d")?.addEventListener("click", loadCar3D);

/** 飞书绑定状态 */
async function loadFeishu() {
  try {
    const d = await get("/api/feishu/status");
    const t = d.target;
    const hit = d.lastHit;
    const hitText = !hit ? "从未收到事件"
      : `${hit.received_at} · ${hit.event_type || hit.type} · ${hit.processed}`
        + (hit.has_encrypt ? " · 事件已加密" : "");
    const hitColor = !hit ? "var(--amber)" : (hit.processed === "handled" ? "var(--green)" : "var(--amber)");
    $("#fs").innerHTML =
      `<div><span>机器人</span><span>${d.bot?.name || "--"} · ${d.bot?.status === 2 ? "已启用" : "未启用"}</span></div>` +
      `<div><span>推送目标</span><span>${t ? `${t.type} = ${t.id}` : "未绑定"}</span></div>` +
      `<div><span>事件回调</span><span style="color:${hitColor}">${hitText}</span></div>` +
      `<div><span>回调地址</span><span style="font-size:12px">${location.origin}/webhook/feishu</span></div>` +
      ((d.chats || []).length
        ? `<div><span>机器人所在群</span><span>${d.chats.map(c => (c.name || c.id) + (c.member_count ? " (" + c.member_count + "人)" : "")).join("、")}</span></div>`
        : `<div><span>机器人所在群</span><span style="color:var(--amber)">无 —— 把机器人拉进任意群后点「自动发现」</span></div>`);
    // 折叠态标题行：只写绑定与否（不写 target id，避免再泄一次会话标识）
    meta("#m-feishu", t ? "已绑定" : "未绑定");
  } catch (e) { /* ignore */ }
}

/** 绑定推送目标 */
async function bindFeishu() {
  const v = ($("#ftarget").value || "").trim();
  if (!v) { $("#fmsg").textContent = "请先粘贴飞书会话链接"; return; }
  $("#fmsg").textContent = "绑定中…";
  //  必须把输入框的值发出去：POST /api/feishu/target 读 body.target（src/index.js:259），
  //   之前这里没传 body → 永远 400「无法解析目标」（D-096 修复）
  const d = await post("/api/feishu/target", { target: v });
  $("#fmsg").textContent = d.ok
    ? ` 已绑定（${d.target.type}=${d.target.id}）并已发送测试消息`
    : ` ${d.error || d.send?.msg || "失败"}（若提示缺少权限，请先在开发者后台开通 im:message:send_as_bot 并发布版本）`;
  loadFeishu();
}

/** 自动发现推送目标（机器人所在的群） */
async function discoverFeishu() {
  $("#fmsg").textContent = "查找机器人所在的群…";
  const d = await post("/api/feishu/discover");
  $("#fmsg").textContent = d.ok
    ? ` 已绑定（${d.target.id}${d.target.name ? " " + d.target.name : ""}）并已发送测试消息`
    : ` ${d.error || "未找到"}`;
  loadFeishu();
}
