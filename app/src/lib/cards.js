/**
 * 飞书 Card 2.0 卡片模板
 *
 * 结构与布局沿用 tesla-butler（特斯拉小管家）的卡片骨架 —— 借鉴的是**设计模式**
 * （指标行 / 字段块 / 图表块 / 状态胶囊），代码为独立实现。
 *
 * 内容口径按增程版设计：电费 + 油费双口径（D-049）。
 */

import { travelStatusText } from "./fields.js";
import { parseShanghai } from "./util.js";

const MD = "lark_md";

/**
 * 标题后缀彩色标签（Card 2.0 `header.text_tag_list`，最多 3 个，超出不展示）
 *
 * 语义色固定：green=正常/在线 · blue=进行中/充电 · orange=提醒 · red=异常 · grey=关闭/中性。
 * 见 docs/design/261112_飞书卡片能力清单与改造映射.md §2.4（D-102）。
 */
export function textTag(text, color = "grey") {
  return { tag: "text_tag", text: { tag: "plain_text", content: String(text) }, color };
}

/**
 * 车名：一律用车辆 App 里自定义的名称（vehicle.nickname），不用车型（spu）。
 * 用户在 App 里常把名字写成「Cong's Li L6 Max」，结尾还是车型，这里去掉结尾的 spu，
 * 只留自定义部分，避免卡片上重复出现型号（D-105）。
 */
export function carName(vehicle) {
  // 严格按车辆 App 里自定义的名称展示，一个字都不改（D-106）；
  // 没设名字时才退回车型，再退回「理想」。
  const nick = String(vehicle?.nickname || "").trim();
  if (nick) return nick;
  const spu = String(vehicle?.spu || "").trim();
  return spu || "理想";
}

/**
 * 指标块（Skill 配方 + 官方 2.0 字段）：column 里放两个 div，带灰底和圆角留白。
 * 为什么不用 interactive_container：它的背景色枚举官方文档没列全，发不出卡的风险高；
 * `grey-50` 是我们已经验证能正常渲染的背景色（D-104 采纳该配方）。
 */
/**
 * 图标元素。注意：飞书 2.0 的 img.size **只接受枚举**（tiny/small/medium/large/stretch），
 * 传 "22px 22px" 会被拒绝（真机报 `img size is not allowed`，D-107 踩坑）。
 */
export function iconImg(imgKey, size = "tiny") {
  //  size 只在 scale_type 为 crop_center / crop_top 时才合法；
  // 之前写成 fit_horizontal + px 尺寸，真机直接 10002 拒卡（D-107 踩坑）。
  return { tag: "img", img_key: imgKey, scale_type: "crop_center", size, transparent: true, preview: false };
}

export function metricBlock(label, value, iconKey) {
  return {
    tag: "column",
    width: "weighted",
    weight: 1,
    background_style: "grey-50",
    padding: "10px 8px 10px 8px",
    vertical_spacing: "2px",
    vertical_align: "center",
    elements: [
      // 图标是自绘 PNG 经 im/v1/images 上传得到的 img_key（D-107）；拿不到就不渲染，卡片照样能发
      iconKey ? iconImg(iconKey) : null,
    ].filter(Boolean).concat([
      {
        tag: "div",
        text: {
          tag: "plain_text",
          content: String(label),
          text_color: "grey",
          text_size: "notation",
          text_align: "center",
        },
      },
      {
        tag: "div",
        text: {
          tag: "plain_text",
          content: String(value),
          text_size: "heading-3",
          text_align: "center",
        },
      },
    ]),
  };
}

/**
 * 一行「标签 · 值」（左标签灰、右值主色），用于折叠面板内的明细。
 * 为什么不用 div.fields：fields 是两列并排，值一长就折行，展开后显得拥挤（D-106）。
 */
/**
 * 两行式明细行：第一行灰标签，第二行值占满整行。
 * 用途：手机窄屏上「标签 + 长值」并排一定折行（如「最费油的一天 11-05 周四 · 发动机 18.5 km · 0.9 L · ¥8.54」），
 * 与其放任浏览器折得难看，不如主动排成上下两行（D-124）。
 */

/** 带图标的一行地址（起点/终点用）：图标 + 单行地名，长地址不折行。 */
export function locRow(iconKey, text) {
  if (!iconKey) return kvRow("", text);
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "8px",
    columns: [
      {
        tag: "column",
        width: "auto",
        vertical_align: "center",
        elements: [iconImg(iconKey, "tiny")],
      },
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        vertical_align: "center",
        elements: [
          { tag: "markdown", content: String(text || DASH), text_size: "normal", text_align: "left" },
        ],
      },
    ],
  };
}

export function stackRow(label, value) {
  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "12px",
    columns: [{
      tag: "column",
      width: "weighted",
      weight: 1,
      vertical_spacing: "2px",
      elements: [
        { tag: "div", text: { tag: "plain_text", content: String(label), text_color: "grey", text_size: "notation" } },
        { tag: "div", text: { tag: "plain_text", content: String(value) } },
      ],
    }],
  };
}

export function kvRow(label, value, weights = [3, 5], opts = {}) {
  return {
    tag: "column_set",
    flex_mode: "bisect",
    horizontal_spacing: "12px",
    columns: [
      {
        tag: "column",
        width: "weighted",
        weight: weights[0],
        elements: [
          { tag: "div", text: { tag: "plain_text", content: String(label), text_color: "grey", text_size: "notation" } },
        ],
      },
      {
        tag: "column",
        width: "weighted",
        weight: weights[1],
        elements: [
          //  value 是 plain_text：**不能塞 <font> 之类的 Markdown 标签**，否则会原样印在卡上
          //  （2026-11-19 电价表就印出了字面量 `<font color='green'>`，D-177 修正）
          {
            tag: "div",
            text: {
              tag: "plain_text",
              content: String(value),
              text_align: "right",
              ...(opts.color ? { text_color: opts.color } : {}),
            },
          },
        ],
      },
    ],
  };
}

/**
 * 胎压四格：左前 / 右前 / 左后 / 右后 各一格，避免四个数字挤成一行看不出是谁的（D-107）。
 */
export function tireGrid(tires) {
  // 用户指定（D-108/D-109）：两行成对，标签里必须出现「胎压」二字，
  // 否则只写「左前」不知道指的是什么；值仍右对齐，与其它行同一节奏。
  const pair = (label, a, b) => {
    const va = tires && tires[a];
    const vb = tires && tires[b];
    const txt = va == null || vb == null
      ? DASH
      : `${Math.round(va)} / ${Math.round(vb)} kPa`;
    return kvRow(label, txt, [4, 4]);
  };
  return [
    pair("胎压 · 左前 / 右前", "左前", "右前"),
    pair("胎压 · 左后 / 右后", "左后", "右后"),
  ];
}

export function header(title, subtitle, tags, template = "blue") {
  // 兼容旧调用：第三个参数传字符串时当作一个灰色标签
  const list = (Array.isArray(tags) ? tags : tags ? [tags] : [])
    .filter(Boolean)
    .slice(0, 3)
    .map((t) => (typeof t === "string" ? textTag(t) : t));
  return {
    template,
    title: { tag: "plain_text", content: title },
    subtitle: subtitle ? { tag: "plain_text", content: subtitle } : undefined,
    ...(list.length ? { text_tag_list: list } : {}),
  };
}

/**
 * 折叠面板（Card 2.0 `collapsible_panel`）—— 次要信息默认收起，正文只留主指标。
 * 注意：官方文档要求用 JSON 代码方式构建，搭建工具不支持。
 */
export function collapsiblePanel(title, elements, opts = {}) {
  const { expanded = false, bordered = true, iconKey = null } = opts;
  return {
    tag: "collapsible_panel",
    expanded,
    vertical_spacing: "8px",
    padding: "8px 8px 8px 8px",
    header: {
      title: { tag: "markdown", content: title },
      vertical_align: "center",
      padding: "4px 0 4px 0",
      //  D-117：用户反馈三角放右侧离文字太远、根本不注意 → 改为放在标题文字最左侧
      icon_position: "left",
      //  D-116：实心三角 ▸ 收起朝右；展开时顺时针转 90° 变 ▾，让"可展开"一眼可见
      icon_expanded_angle: 90,
      ...(iconKey ? { icon: { tag: "custom_icon", img_key: iconKey, size: "16px 16px" } } : {}),
    },
    ...(bordered ? { border: { color: "grey", corner_radius: "8px" } } : {}),
    elements,
  };
}

export function cardShell(title, subtitle, summary, elements, opts = {}) {
  const { template = "blue", url, tags = null } = opts;
  return {
    schema: "2.0",
    config: {
      update_multi: true,
      width_mode: "fill",
      summary: { content: summary || title },
      style: { text_size: { metric: { default: "heading-3", pc: "heading-2", mobile: "heading-4" } } },
    },
    header: header(title, subtitle, tags, template),
    body: {
      direction: "vertical",
      padding: "12px 12px 20px 12px",
      vertical_spacing: "12px",
      elements,
    },
    ...(url ? { url } : {}),
  };
}

export function metricColumn(label, value, opts = {}) {
  return {
    tag: "column",
    ...(opts.accent ? { background_style: "grey-50" } : {}),
    elements: [
      { tag: "markdown", content: `**${label}**`, text_align: "center", text_size: "notation" },
      { tag: "markdown", content: `**${value}**`, text_align: "center", text_size: opts.large ? "heading-2" : "heading-3" },
    ],
  };
}

export function metricRow(items, flexMode = "none") {
  return {
    tag: "column_set",
    flex_mode: flexMode,
    horizontal_spacing: "8px",
    columns: flexMode === "none"
      ? items.map((c) => ({ ...c, width: "weighted", weight: 1 }))
      : items,
  };
}

export function field(label, value, isShort = true) {
  return { is_short: isShort, text: { tag: MD, content: `**${label}**\n${value}` } };
}

export function fields(items) {
  return { tag: "div", fields: items };
}

export function note(content, size = "notation") {
  return { tag: "markdown", content, text_size: size };
}

export function divider() {
  return { tag: "hr" };
}

/**
 * 柱状图 —— **Card 2.0 的 chart_spec 格式**
 *
 *  踩坑记录：Card 1.0 的写法（`horizontal` / `data: [...]` / `chart_max`）
 *    在 Card 2.0 里会直接报
 *    `unknown property, property: horizontal, path: ROOT -> body -> elements -> [3](tag: chart)`
 *    → **卡片整个发不出去**。
 *
 * 正确格式（与 tesla-butler 验证过的写法一致）：
 *   { tag:"chart", height, preview, color_theme,
 *     chart_spec: { type:"bar", direction, data:{values:[{...}]},
 *                   xField, yField, color, title, legends, padding, label, axes, media } }
 *
 * @param {{title:string, data:{name:string,value:number}[], xField?:string, yField?:string, height?:string}} o
 */
export function chart({ title, data, xField = "day", yField = "km", height = "180px", color = ["#3370FF"], axisTitle = "" }) {
  const values = data.map((d) => ({ [xField]: d.name, [yField]: Number(d.value) || 0 }));
  return {
    tag: "chart",
    height,
    preview: false,
    color_theme: "primary",
    chart_spec: {
      type: "bar",
      direction: "vertical",
      data: { values },
      xField,
      yField,
      color,
      title: { visible: true, text: title },
      legends: { visible: false },
      padding: { top: 8, right: 16, bottom: 4, left: 4 },
      bar: { style: { cornerRadius: 3 } },
      label: { visible: true, position: "outside", overlap: false, style: { fontSize: 10, fill: "#8ea0b4" } },
      axes: [
        { orient: "bottom", title: { visible: !!axisTitle, text: axisTitle }, grid: { visible: false } },
        { orient: "left", min: 0, title: { visible: false }, grid: { visible: false } },
      ],
      media: [],
    },
  };
}

/** 去掉卡片里的 chart 元素（图表语法出错时的降级用） */
export function stripCharts(card) {
  if (!card?.body?.elements) return card;
  card.body.elements = card.body.elements.filter((e) => e?.tag !== "chart");
  return card;
}

/** 一行状态胶囊（电量 / 充电 / 在线） */
export function statusPill(text, color = "grey") {
  return {
    tag: "markdown",
    content: `<font color='${color}'>${text}</font>`,
  };
}

// ─────────────────────── 共享格式化层（数字与单位写法 · 硬规则） ───────────────────────
// 口径：docs/design/260826_设计令牌与组件规范.md §4。
// 约定三条：
//   ① **单位拼接只在本层发生** —— 调用方只传数值和单位名，不再自己写 `" km"` 这种前导空格；
//   ② 数值与单位之间一个半角空格，`%` 不加空格；
//   ③ 空值一律 `--`（不带单位、不带符号，绝不出现 `--%` / `-- km` / 空串）。

const DASH = "--";

/** 空值判定：null / undefined / 空串 / 非有限数字 */
function isBlank(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  if (typeof v === "number" && !Number.isFinite(v)) return true;
  return false;
}

/** 数值化：拿不到有限数字就返回 null（字符串 "abc" 也当空） */
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

function num2(v) {
  const n = toNum(v);
  return n == null ? DASH : String(Math.round(n));
}

function toNum(v) {
  if (isBlank(v) || typeof v === "boolean") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 数值 + 单位：`18.3 km` / `0.31 kWh` / `7.5 L/100km` / `384.4 V`
 * 数字与单位之间**一个半角空格**；空值 `--`（不带单位）。
 */
export function fmtNum(v, unit = "", digits = 1) {
  const n = toNum(v);
  if (n === null) return DASH;
  const s = n.toFixed(digits);
  return unit ? `${s} ${unit}` : s;
}

/** 百分比：`72%`（不加空格）；空值 `--`（不是 `--%`） */
export function fmtPct(v, digits = 0) {
  const n = toNum(v);
  return n === null ? DASH : `${n.toFixed(digits)}%`;
}

/** 金额：`¥45.63`（两位小数）；空值 `--` */
export function fmtMoney(v) {
  const n = toNum(v);
  return n === null ? DASH : `¥${n.toFixed(2)}`;
}

/** 单价：电价 `0.68 元/度`、油价 `7.85 元/L`（两位小数，不用三位） */
export function fmtPrice(v, unit = "元/度") {
  const n = toNum(v);
  return n === null ? DASH : `${n.toFixed(2)} ${unit}`;
}

/** 里程累计值：整数（`21683 km`） */
export function fmtKmTotal(v) {
  return fmtNum(v, "km", 0);
}

/** 里程单次行程：一位小数（`18.3 km`） */
export function fmtKmTrip(v) {
  return fmtNum(v, "km", 1);
}

/** 电量：一位小数（`0.31 kWh` 按 §4 显示 `0.3 kWh`） */
export function fmtKwh(v) {
  return fmtNum(v, "kWh", 1);
}

/** 温度：一位小数 + ℃（`21.0 ℃`） */
export function fmtTemp(v) {
  return fmtNum(v, "℃", 1);
}

/** 时长：`33 分`；≥60 分钟 `1 小时 12 分`；空值 `--` */
export function fmtDuration(min) {
  const n = toNum(min);
  if (n === null || n < 0) return DASH;
  const m = Math.round(n);
  if (m < 60) return `${m} 分`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} 小时 ${rest} 分` : `${h} 小时`;
}

/**
 * 胎压一行：`209 / 209 / 215 / 209 kPa`
 * 顺序固定 左前 / 右前 / 左后 / 右后，取整，单位只出现一次；单个缺失用 `--` 占位。
 */
export function fmtTires(tires) {
  if (!tires || typeof tires !== "object") return DASH;
  const slots = ["左前", "右前", "左后", "右后"].map((k) => {
    const n = toNum(tires[k]);
    return n === null ? DASH : String(Math.round(n));
  });
  if (slots.every((s) => s === DASH)) return DASH;
  return `${slots.join(" / ")} kPa`;
}

/** 估算值前缀「约」：只用于 §4 白名单（本程耗电/电费/耗油/油费、加油量） */
export function approx(text) {
  return text === DASH ? DASH : `约 ${text}`;
}

/** 采样时刻 → HH:MM（副标题/尾注用；拿不到就空串） */
function hhmm(at) {
  if (!at) return "";
  const m = String(at).replace("T", " ").match(/(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : "";
}

// ───────────────────────────────────────── 卡片

/** 状态卡尾注：1 行内说清「采集几路正常 / 哪一路异常 / 更新时刻」 */
function statusFootnote(health) {
  // D-106：正常时不显示任何尾注——「采集 3/3 正常」对用户是噪音，
  // 且「更新于 HH:MM」与副标题「HH:MM 更新」重复。只有异常才提示，且只说人话。
  const list = Array.isArray(health) ? health.filter(Boolean) : [];
  const bad = list.filter((h) => !h.ok);
  if (!bad.length) return "";
  const LABEL = { vss: "车况", creds: "登录态", daily: "日报数据", vehicles: "车辆资料" };
  const names = bad.map((h) => LABEL[h.kind] || h.kind || "未知").join("、");
  return `<font color='red'>采集异常：${names}</font>`;
}

/**
 * 车辆状态速览（P0-5）
 *
 * 信息架构（D-103 改版，手机一屏读完）：
 *   头部「车辆状态 / spu · HH:MM 更新」+ 2 个彩色标签（充电状态 / 哨兵）
 *   → 主指标 3 列（电量 / 纯电续航 / 燃油续航）—— 一眼要的三个数
 *   → 折叠面板「更多状态 · 8 项」：总里程 / 油量 / 车内温度 / 车速
 *                                    + 行驶状态 / 电池包电压 / 胎压 / OTA
 *   → 尾注 1 行（采集健康 + 更新时刻）
 *
 * 为什么把「状态」从主指标挪进标题标签：4 列在手机上每列只剩 ~70px，「充电中/未充电」
 * 这种异步状态用彩色标签表达更快，也把主指标行从 4 列压到 3 列（每格更宽、数字更大）。
 * 为什么加折叠：改版前 6 个字段平铺会多占 ~120px，折叠后正文只留 3 个数 + 1 行入口。
 * 车牌不进卡片（噪音，F8）；字段全部走共享格式化层，空值统一 `--`。
 */
/**
 * 电量续航卡（D-163）：把原来「电量」「续航」两条纯文字指令合并成一张卡。
 * 三块只放用户最关心的三个数（电量 / 纯电续航 / 燃油续航），
 * 油量、合计续航、电压进折叠——手机上一屏能看完，不用再读两行文字。
 */
export function buildBatteryCard({ battery, rangeElec, rangeFuel, fuelLevel, packVoltage, charging, chargeStatusText, vehicle, icons, at }) {
  const ic = (name) => (icons && icons[name]) || null;
  const total = rangeElec != null && rangeFuel != null ? Number(rangeElec) + Number(rangeFuel) : null;

  const rows = [];
  rows.push(kvRow("油量", fuelLevel != null ? fmtPct(fuelLevel) : DASH));
  if (total != null) rows.push(kvRow("合计续航", approx(fmtNum(total, "km", 0))));
  if (packVoltage != null) rows.push(kvRow("电池包电压", fmtNum(packVoltage, "V", 1)));
  rows.push(kvRow("更新时间", hhmm(at)));

  const tag = charging ? textTag("充电中", "green") : textTag(chargeStatusText || "未充电", "wathet");

  return cardShell("电量续航", `${carName(vehicle)} · ${hhmm(at)} 更新`, "电量与续航", [
    metricRow([
      metricBlock("电量", fmtPct(battery), ic("battery")),
      metricBlock("纯电续航", fmtNum(rangeElec, "km", 0), ic("bolt_green")),
      metricBlock("燃油续航", fmtNum(rangeFuel, "km", 0), ic("fuel_amber")),
    ]),
    collapsiblePanel(`更多信息 · ${rows.length} 项`, rows),
  ], { template: "blue", tags: [tag] });
}

/**
 * 车辆位置卡（D-163）：原来是一段纯文字（地址 + 坐标 + 时间 + 距家）。
 * 坐标对用户没意义，正文只留地址，坐标与围栏半径收进折叠。
 */
export function buildLocationCard({ address, lat, lon, at, fences = [], travelText, battery, vehicle, icons }) {
  const ic = (name) => (icons && icons[name]) || null;
  const near = fences.length ? fences[0] : null;

  const rows = [];
  if (address) rows.push(kvRow("完整地址", address));
  rows.push(kvRow("坐标", `${fmtNum(lat, "", 4)}, ${fmtNum(lon, "", 4)}`));
  if (near) rows.push(kvRow("围栏参考", `「${near.label}」半径 ${Math.round(Number(near.radius) || 400)} m`));
  rows.push(kvRow("采样时间", hhmm(at)));

  const first = near
    ? metricBlock(`距「${near.label}」`, `${Math.round(Number(near.d))} m`, ic("map"))
    : metricBlock("坐标", `${fmtNum(lat, "", 3)}, ${fmtNum(lon, "", 3)}`, ic("map"));

  return cardShell("车辆位置", `${carName(vehicle)} · ${hhmm(at)} 采样`, "车辆位置", [
    metricRow([
      first,
      metricBlock("车辆状态", travelText || DASH, ic("gauge_blue")),
      metricBlock("当前电量", battery != null ? fmtPct(battery) : DASH, ic("battery")),
    ]),
    { tag: "markdown", content: address ? `**${address}**` : "暂时解析不出地址（逆地理失败）", text_size: "normal" },
    collapsiblePanel(`更多信息 · ${rows.length} 项`, rows),
  ], { template: "blue" });
}

/**
 * 保养剩余卡（D-163）：原来是一段六行文字。
 * 三块放「最紧的那一项」，六项明细进折叠；剩余 <1000 km 时整卡转橙色提醒。
 */
const MAINT_LABELS = {
  enginelevel1: "增程器机油",
  enginelevel2: "增程器机滤",
  acfilter: "空调滤芯",
  sparkplug: "火花塞",
  coolfuild: "冷却液",
  gearbrakeoil: "齿轮/刹车油",
};

export function buildMaintCard({ maint, odoKm, vehicle, icons }) {
  const ic = (name) => (icons && icons[name]) || null;
  const items = Object.entries(maint || {})
    .filter(([k, v]) => v && v.left != null && MAINT_LABELS[k])
    .map(([k, v]) => ({ key: k, label: MAINT_LABELS[k], left: Number(v.left), period: v.period != null ? Number(v.period) : null, byEngine: Boolean(v.byEngine) }))
    .sort((a, b) => a.left - b.left);
  if (!items.length) return null;

  const next = items[0];
  const usedPct = next.period ? Math.max(0, Math.min(100, Math.round((1 - next.left / next.period) * 100))) : null;
  const urgent = next.left <= 1000;

  const rows = items.map((it) => kvRow(
    it.label,
    `${fmtNum(it.left, "km", 0)}${it.period ? ` / ${fmtNum(it.period, "km", 0)}` : ""}${it.byEngine ? "（按增程器）" : ""}`,
  ));

  return cardShell("保养剩余", `${carName(vehicle)} · 总里程 ${fmtKmTotal(odoKm)}`, "保养剩余里程", [
    metricRow([
      metricBlock("下次保养", next.label, ic("gauge_blue")),
      metricBlock("剩余里程", fmtNum(next.left, "km", 0), ic("clock")),
      metricBlock("已用周期", usedPct != null ? fmtPct(usedPct) : DASH, ic("tire")),
    ]),
    collapsiblePanel(`全部 ${rows.length} 项`, rows),
  ], { template: urgent ? "orange" : "blue", tags: urgent ? [textTag("建议预约", "orange")] : [] });
}

/**
 * 充电账单卡（D-163）：原来是一段「充电 N 次 · X kWh · ¥Y · 均价 Z」的文字。
 */
export function buildBillsCard({ month, sessions, kwh, cost, avg, vehicle, icons }) {
  const ic = (name) => (icons && icons[name]) || null;
  const rows = [];
  if (avg != null) rows.push(kvRow("平均单价", fmtPrice(avg)));
  rows.push(kvRow("统计口径", "电费按每次充电的分时实付价累加"));
  rows.push(kvRow("均价算法", "电费 ÷ 充入电量（分时价加权）"));

  return cardShell("充电账单", `${month} · ${carName(vehicle)}`, "当月充电账单", [
    metricRow([
      metricBlock("充电次数", `${num2(sessions)} 次`, ic("plug")),
      metricBlock("充入电量", fmtKwh(kwh), ic("bolt_green")),
      metricBlock("电费", fmtMoney(cost), ic("coin")),
    ]),
    collapsiblePanel(`说明 · ${rows.length} 项`, rows),
  ], { template: "blue", tags: [avg != null ? textTag(`均价 ${Number(avg).toFixed(3)} 元/度`, "wathet") : textTag("本月暂无充电", "grey")] });
}

/**
 * 最近充电流水卡（D-163）：三块摘要 + `table` 明细。
 * 注意 Card 2.0 的 table 只能放根节点、单卡最多 5 个、每页 1~10 行（D-102）。
 */
export function buildChargeHistoryCard({ rows, vehicle, icons }) {
  const ic = (name) => (icons && icons[name]) || null;
  const latest = rows[0] || null;

  const table = rows.length
    ? [{
        tag: "table",
        page_size: Math.min(rows.length, 10),
        row_height: "low",
        header_style: { background_style: "grey", text_size: "notation", bold: true },
        columns: [
          { name: "at", display_name: "开始时间", data_type: "text", width: "auto" },
          { name: "kwh", display_name: "电量", data_type: "number", format: { symbol: "kWh", precision: 1, separator: false }, horizontal_align: "right" },
          { name: "price", display_name: "单价", data_type: "number", format: { symbol: "元/度", precision: 2, separator: false }, horizontal_align: "right" },
          { name: "cost", display_name: "电费", data_type: "number", format: { symbol: "¥", precision: 2, separator: false }, horizontal_align: "right" },
        ],
        rows: rows.map((r) => ({
          at: String(r.started_at || "").slice(5, 16),
          kwh: toNum(r.capacity_kwh) ?? 0,
          price: toNum(r.price_per_kwh) ?? 0,
          cost: toNum(r.cost_cny) ?? 0,
        })),
      }]
    : [];

  return cardShell("最近充电", `${carName(vehicle)} · 共 ${rows.length} 次`, "最近充电流水", [
    metricRow([
      metricBlock("最近一次电费", latest ? fmtMoney(latest.cost_cny) : DASH, ic("coin")),
      metricBlock("充入电量", latest ? fmtKwh(latest.capacity_kwh) : DASH, ic("bolt_green")),
      metricBlock("充电时长", latest && latest.duration_min != null ? fmtDuration(latest.duration_min) : DASH, ic("clock")),
    ]),
    ...table,
    note("发「账单」看当月汇总。"),
  ], { template: "green", tags: latest && latest.price_per_kwh != null ? [textTag(fmtPrice(latest.price_per_kwh), "wathet")] : [] });
}

/**
 * 当前电价卡（D-163）：口径与电费一致——沿用「上一次充电的实际电价」（D-078），
 * 不是「现在这一分钟的分时价」，所以卡片上要说清来源，避免和账单对不上。
 */
export function buildElecPriceCard({ price, at, kwh, valleyPrice, valleyWindow, vehicle, icons }) {
  const ic = (name) => (icons && icons[name]) || null;
  const rows = [];
  if (at) rows.push(kvRow("上次充电时间", hhmm(at)));
  if (kwh != null) rows.push(kvRow("上次充入电量", fmtKwh(kwh)));
  if (valleyWindow) rows.push(kvRow("谷时时段", valleyWindow));
  rows.push(kvRow("口径", "电费沿用上次充电的实际电价，不是当前分钟的分时价"));

  const blocks = [
    metricBlock("当前电价", fmtPrice(price), ic("bolt_green")),
  ];
  blocks.push(valleyPrice != null
    ? metricBlock("谷时电价", fmtPrice(valleyPrice), ic("bolt"))
    : metricBlock("上次充电", at ? hhmm(at) : DASH, ic("clock")));
  blocks.push(metricBlock("上次充入", kwh != null ? fmtKwh(kwh) : DASH, ic("battery_blue")));

  return cardShell("当前电价", carName(vehicle), "当前电价", [
    metricRow(blocks),
    collapsiblePanel(`说明 · ${rows.length} 项`, rows),
  ], { template: "blue", tags: [textTag("来自上次充电", "wathet")] });
}

/**
 * 油价卡（D-163）：只读展示，改价仍然在「加油已完成」那张卡里填（用户明确要求，2026-11-18）。
 */
export function buildFuelPriceCard({ price, updatedAt, vehicle, icons }) {
  const ic = (name) => (icons && icons[name]) || null;
  const rows = [];
  if (updatedAt) rows.push(kvRow("上次更新", String(updatedAt).slice(0, 16)));
  rows.push(kvRow("生效口径", "油费 = 发动机里程 ÷ 100 × 油耗基准 × 油价"));
  rows.push(kvRow("修改方式", "加油提醒卡里填本次单价，或发「油价 9.49」"));

  return cardShell("油价", carName(vehicle), "当前 95# 油价", [
    metricRow([
      metricBlock("当前油价", fmtPrice(price, "元/L"), ic("fuel_amber")),
      metricBlock("上次更新", updatedAt ? String(updatedAt).slice(5, 10) : DASH, ic("clock")),
    ]),
    collapsiblePanel(`说明 · ${rows.length} 项`, rows),
  ], { template: "blue", tags: [textTag("95# 汽油", "wathet")] });
}

/**
 * 帮助/客服卡（D-164）：原来「帮助」和「指令菜单」回同一张菜单卡，用户反馈重复。
 * 改成官方客服电话 + 官方入口，指令清单交给「指令菜单」。
 */
export const SUPPORT_PHONE = "400-686-0900";

export function buildSupportCard({ vehicle, icons }) {
  const ic = (name) => (icons && icons[name]) || null;
  const rows = [
    kvRow("官方网址", "lixiang.com"),
    kvRow("道路救援", `${SUPPORT_PHONE}（同号，7×24 小时）`),
    kvRow("查车用指令", "点下面按钮，或发「菜单」"),
  ];
  return cardShell("帮助与客服", carName(vehicle), "理想汽车官方客服", [
    metricRow([
      metricBlock("客服电话", SUPPORT_PHONE, ic("plug")),
      metricBlock("服务时间", "7×24 小时", ic("clock")),
      metricBlock("服务内容", "咨询·救援·投诉", ic("gauge_blue")),
    ]),
    note(`拨打 ${SUPPORT_PHONE} 可以咨询车辆问题、预约维保、申请道路救援。`),
    collapsiblePanel(`更多信息 · ${rows.length} 项`, rows),
    actionRow([{ text: "指令菜单", cmd: "菜单" }]),
  ], { template: "blue", tags: [textTag("官方客服", "wathet")] });
}

export function buildStatusCard({ s, trip, vehicle, health, icons = null }) {
  const ic = (n) => (icons && icons[n]) || null;
  const d = s?.detail || {};
  const at = hhmm(s?.sampled_at);
  const name = carName(vehicle);
  const subtitle = [name, at ? `${at} 更新` : ""].filter(Boolean).join(" · ") || "车辆状态速览";

  const charging = !!s?.charging;
  const sentinel = d.sentinel_text || "";
  const sentinelOn = /开启|开/.test(sentinel) && !/关闭/.test(sentinel);
  const tags = [
    //  D-118（用户指定）：状态标签用颜色表达"有事/无事"——
    //   充电中=绿、未充电=灰；哨兵开=红（在录像，意味着有耗电与隐私含义）、哨兵关=灰
    //  D-119：grey 在深色卡片上几乎看不出是标签（用户实测"看不出任何标签痕迹"），
    //   默认态改用 wathet（浅蓝灰）——仍属中性，但有底色块，一眼能认出这是标签。
    charging ? textTag("充电中", "green") : textTag("未充电", "wathet"),
    sentinel ? textTag(sentinelOn ? "哨兵 开" : "哨兵 关", sentinelOn ? "red" : "wathet") : null,
  ].filter(Boolean);

  // 折叠面板内用「一行一对」的 kvRow，而不是 4 列指标 + 2 列 fields：
  // fields 值一长就折行，展开后显得拥挤（D-106）。车速只在真正行驶时才有意义。
  const moving = [1, 2, 3].includes(Number(d.travel_status));
  const more = [
    kvRow("总里程", fmtKmTotal(s?.odometer_km ?? trip?.mileage_km)),
    kvRow("油量", fmtPct(d.fuel_level)),
    moving ? kvRow("车速", fmtNum(s?.speed, "km/h", 0)) : null,
    kvRow("车内温度", fmtTemp(s?.indoor_temp)),
    // 优先用原始枚举现算文案：runtime_state 里缓存的是上次写入时的中文，
    // 改文案后旧缓存会长期显示旧措辞（D-106 踩坑）。
    kvRow("行驶状态", d.travel_status != null ? travelStatusText(d.travel_status) : (d.travel_status_text || DASH)),
    ...tireGrid(d.tires),
    kvRow("电池包电压", fmtNum(d.pack_voltage, "V", 1)),
    kvRow("OTA 版本", d.ota_version || DASH),
  ].filter(Boolean);

  const elements = [
    // 主指标：还有多少电 / 能跑多远（纯电、燃油分开，避免和「综合续航」混淆，D-097）
    {
      tag: "column_set",
      flex_mode: "trisect",
      horizontal_spacing: "8px",
      columns: [
        metricBlock("电量", fmtPct(s?.battery), ic("battery")),
        // index.js 两处调用没有 detail，只有顶层 range_km → 退化为纯电续航
        metricBlock("纯电续航", fmtNum(d.range_elec ?? s?.range_km, "km", 0), ic("bolt")),
        metricBlock("燃油续航", fmtNum(d.range_fuel, "km", 0), ic("fuel")),
      ],
    },
    // 去掉边框：带边框时观感像输入框（D-106）
    collapsiblePanel(`更多状态 · ${more.length} 项`, more, { iconKey: ic("chevron") }),
    // 尾注只在采集异常时出现（正常不占位）
    statusFootnote(health) ? note(`<font color='grey'>${statusFootnote(health)}</font>`) : null,
  ];
  return cardShell("车辆状态", subtitle, "车辆状态速览", elements.filter(Boolean), { template: "blue", tags });
}

/** 昨日用车小结（P0-2，增程双口径）。
 *  D-198：标题原为「每日用车小结」，与「今日」查询卡只差三个字，用户分不清谁在推谁在查；
 *  改成「昨日小结」直接点明时间口径（这张卡报的就是昨天）。 */
export function buildDailyCard({ d, vehicle = null, priceCny, fuelPriceCny, dateLabel, priceNote = null, icons = null }) {
  const ic = (k) => (icons && icons[k]) || null;
  const pureRatio = d.travel_km > 0 ? (d.elec_km / d.travel_km) * 100 : 0;
  //  D-113：日报的「电费」必须是「当天行驶耗电 × 电价」，而不是「当天充电花掉的钱」。
  //   d.cost_cny 在「当天有充电」时会被 collect.js:1596 覆写成充电会话的实际花费（25.3 kWh × 0.68 = ¥17.19），
  //   与同一张卡上的「耗电 0.5 kWh」自相矛盾（用户 2026-11-13 直接问「2.7 公里怎么会花 17.5 元」）。
  //   实际充电花销单独一行「充电花费」，两个口径分开显示，谁也不覆盖谁。
  const fuelL = Number(d.fuel_l) || 0;
  const chargeKwh = Number(d.charge_kwh) || 0;
  const elecKwh = Number(d.elec_kwh) || 0;
  const drivingCost = priceCny !== null && priceCny !== undefined
    ? round2(elecKwh * Number(priceCny))
    : (Number(d.cost_cny) || 0);
  const chargeCost = chargeKwh > 0.05 ? Number(d.cost_cny) || 0 : null;
  const total = drivingCost + (Number(d.fuel_cost_cny) || 0);
  // D-112：标签只放"这天发生了什么"，纯电占比是派生比例、不配占用标题位。
  // D-115：手机窄屏放 3 个标签会折行（电脑端不会），所以固定「最多显示 2 个」：
  //   优先级 智驾(蓝) > 充电(绿) > 用油(橙)，按优先级排序后取前两个（后面的自动顺补，例如只有智驾+用油就显示这两个）。
  const adKm = Number(d.ad_km) || 0;
  const allTags = [];
  if (adKm >= 0.5) allTags.push(textTag(`智驾 ${fmtNum(adKm, "km", adKm >= 100 ? 0 : 1)}`, "blue"));
  if (chargeKwh > 0.05) allTags.push(textTag(`充电 ${fmtKwh(chargeKwh)}`, "green"));
  if (fuelL > 0.05) allTags.push(textTag(`用油 ${fmtNum(fuelL, "L", 1)}`, "orange"));
  const tags = allTags.slice(0, 2);
  const detail = [
    kvRow("纯电里程", fmtKmTrip(d.elec_km)),
    kvRow("发动机里程", fmtKmTrip(d.hybrid_km)),
    kvRow("纯电占比", fmtPct(pureRatio)),
    kvRow("电耗率", fmtNum(d.avg_elec_kwh_per_100km, "kWh/100km", 1)),
    kvRow("油耗", fmtNum(d.fuel_l, "L", 1)),
    kvRow("油耗率", fmtNum(d.avg_fuel_l_per_100km, "L/100km", 1)),
    kvRow("行驶电费", fmtMoney(drivingCost)),
    kvRow("油费", fmtMoney(d.fuel_cost_cny)),
    kvRow("智驾里程", fmtKmTrip(d.ad_km)),
    chargeKwh > 0.05 ? kvRow("充电量", fmtKwh(chargeKwh)) : null,
    chargeCost !== null ? kvRow("充电花费", fmtMoney(chargeCost)) : null,
    kvRow("电价", fmtPrice(priceCny)),
    priceNote ? kvRow("电价来源", String(priceNote).replace(/^按\s*/, "").replace(/\s*那次充电的电价$/, " 充电")) : null,
  ].filter(Boolean);
  const elements = [
    metricRow([
      metricBlock("里程", fmtKmTrip(d.travel_km), ic("gauge_blue")),
      metricBlock("耗电", fmtKwh(d.elec_kwh), ic("bolt_green")),
      metricBlock("合计费用", fmtMoney(total), ic("coin")),
    ]),
    collapsiblePanel(`更多数据 · ${detail.length} 项`, detail, { iconKey: ic("chevron") }),
  ];
  const subtitle = `${carName(vehicle)} · ${dateLabel}`;
  return cardShell("昨日用车小结", subtitle, "昨日里程与花费", elements, { template: "green", tags });
}

export function buildMonthlyCard({
  summary, days, monthLabel, highlights = null, fuel = null,
  vehicle = null, priceCny = null, icons = null, prev = null, title = "本月用车小结",
}) {
  //  D-126：月报改成与周报同一套四段式（主指标 / 周柱图 / 折叠明细 / 高亮），
  //   否则 30 天数据挤在 4×2 指标格里，手机上不可读；电费口径也按 D-122 拆成「行驶电费 + 充电花费」。
  const ic = (k) => (icons && icons[k]) || null;
  const elecKwh = Number(summary.elec_kwh) || 0;
  const fuelCost = Number(summary.fuel_cost_cny) || 0;
  const chargeKwh = Number(summary.charge_kwh) || 0;
  const chargeTimes = Number(summary.charge_times) || 0;
  const chargeDays = (days || []).filter((d) => (Number(d.charge_kwh) || 0) > 0.05);
  const chargeCost = chargeDays.length
    ? round2(chargeDays.reduce((a, d) => a + (Number(d.cost_cny) || 0), 0))
    : null;
  const monthPrice = chargeCost !== null && chargeKwh > 0.05 ? chargeCost / chargeKwh : null;
  const effPrice = monthPrice !== null
    ? monthPrice
    : (priceCny !== null && priceCny !== undefined && priceCny !== "" ? Number(priceCny) : null);
  const drivingCost = effPrice !== null ? round2(elecKwh * effPrice) : round2(0);
  const total = round2(drivingCost + fuelCost);
  const adKm = Number(summary.ad_km) || 0;
  const elecKm = Number(summary.elec_km) || 0;
  const hybKm = Number(summary.hybrid_km) || 0;

  // D-127：月报固定显示 2 个标签 —— 先按「充电 > 用油 > 智驾」放真实发生的事，
  //   不足 2 个时用「纯电占比 → 驾驶天数」顺补，避免只剩一个标签显得空。
  const allTags = [];
  if (chargeKwh > 0.05) allTags.push(textTag(`充电 ${fmtNum(chargeTimes, "", 0)} 次 · ${fmtKwh(chargeKwh)}`, "green"));
  if (Number(summary.fuel_l) > 0.05) allTags.push(textTag(`用油 ${fmtNum(summary.fuel_l, "L", 1)}`, "orange"));
  if (adKm >= 0.5) allTags.push(textTag(`智驾 ${fmtNum(adKm, "km", adKm >= 100 ? 0 : 1)}`, "blue"));
  const padTags = [
    Number(summary.pure_ratio) > 0 ? textTag(`纯电 ${fmtPct(summary.pure_ratio)}`, "wathet") : null,
    Number(summary.active_days) > 0 ? textTag(`驾驶 ${fmtNum(summary.active_days, "天", 0)}`, "wathet") : null,
  ].filter(Boolean);
  for (const t of padTags) { if (allTags.length >= 2) break; allTags.push(t); }
  const tags = allTags.slice(0, 2);

  // 30 天逐日柱图在手机上会挤成细线 → 按「第 N 周」聚合（每月最多 5 根柱）
  const weekBuckets = new Map();
  for (const d of days || []) {
    const day = Number(String(d.stat_date || "").slice(8, 10));
    if (!(day >= 1)) continue;
    const wk = Math.ceil(day / 7);
    weekBuckets.set(wk, round2((weekBuckets.get(wk) || 0) + (Number(d.travel_km) || 0)));
  }
  const chartData = [...weekBuckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([wk, km]) => ({ name: `第${wk}周`, value: km.toFixed(1) }));

  // 高亮：行驶距离最长/最短相邻，最费油放最后且用发动机里程（同 D-122/D-123）
  const moved = (days || []).filter((d) => (Number(d.travel_km) || 0) > 0);
  const hi = [];
  if (moved.length) {
    const far = moved.slice().sort((a, b) => (Number(b.travel_km) || 0) - (Number(a.travel_km) || 0))[0];
    hi.push(kvRow("行驶距离最长的一天", `${String(far.stat_date).slice(5)} ${weekdayCn(far.stat_date)} · ${fmtKmTrip(far.travel_km)}`, [4, 4]));
    const near = moved.slice().sort((a, b) => (Number(a.travel_km) || 0) - (Number(b.travel_km) || 0))[0];
    hi.push(kvRow("行驶距离最短的一天", `${String(near.stat_date).slice(5)} ${weekdayCn(near.stat_date)} · ${fmtKmTrip(near.travel_km)}`, [4, 4]));
    const fuelDay = moved.slice().sort((a, b) => (Number(b.fuel_l) || 0) - (Number(a.fuel_l) || 0))[0];
    if ((Number(fuelDay.fuel_l) || 0) > 0.05) {
      hi.push(stackRow("最费油的一天", `${String(fuelDay.stat_date).slice(5)} ${weekdayCn(fuelDay.stat_date)} · 发动机 ${fmtKmTrip(fuelDay.hybrid_km)} · ${fmtNum(fuelDay.fuel_l, "L", 1)} · ${fmtMoney(fuelDay.fuel_cost_cny)}`));
    }
  } else if (highlights?.length) {
    // 兜底：没有逐日数据时退回旧的三条 highlights 文案
    for (const h of highlights) hi.push(kvRow(h.label, h.value, [4, 4]));
  }

  const cmpText = (() => {
    const p0 = Number(prev?.travel_km);
    const c0 = Number(summary.travel_km);
    if (!(p0 > 0) || !(c0 >= 0)) return DASH;
    const pct = ((c0 - p0) / p0) * 100;
    return `${pct >= 0 ? "+" : "-"}${Math.abs(pct).toFixed(0)}%（${fmtNum(p0, "", 1)} km → ${fmtNum(c0, "", 1)} km）`;
  })();

  const detail = [
    kvRow("纯电里程", fmtKmTrip(summary.elec_km)),
    kvRow("发动机里程", fmtKmTrip(summary.hybrid_km)),
    kvRow("纯电占比", fmtPct(summary.pure_ratio)),
    // 电费两行：行驶电费（用车消耗的电）与充电花费（买电实付）分开，互不覆盖（D-122/D-126）
    kvRow("行驶电费", fmtMoney(drivingCost)),
    kvRow("行驶油费", fmtMoney(fuelCost)),
    adKm >= 0.5 ? kvRow("智驾里程", fmtKmTrip(adKm)) : null,
    kvRow("驾驶天数", `${fmtNum(summary.active_days, "", 0)} 天`),
    kvRow("日均里程", fmtKmTrip(summary.daily_avg_km)),
    kvRow("每公里综合成本", elecKwh + Number(summary.fuel_l || 0) > 0 ? fmtMoney(total / (Number(summary.travel_km) || 1)) : DASH),
    // 月汇总里没有现成的率值（只有周报的 energyAggregate 带）→ 用同口径现算：度数 / 对应里程
    kvRow("电耗率", elecKm > 0 ? fmtNum((elecKwh / elecKm) * 100, "kWh/100km", 1) : DASH),
    kvRow("油耗率", hybKm > 0 ? fmtNum((Number(summary.fuel_l || 0) / hybKm) * 100, "L/100km", 1) : DASH),
    // D-127：与周报一致 —— 手机上一行放不下就主动排两行，不让它在数字中间折
    stackRow("和上月对比", cmpText),
    chargeCost !== null ? kvRow("充电花费", fmtMoney(chargeCost), [4, 4]) : null,
    // D-127：用户指出「电价（上次充电）0.68 元/度」看不懂 —— 拆成两种明确表达：
    //   本月充过电 → 「本月充电均价」；本月没充过电 → 「电价」+ 一句说明它是沿用上次充电价估算行驶电费
    monthPrice !== null ? kvRow("本月充电均价", fmtPrice(monthPrice), [4, 4]) : null,
    monthPrice === null && effPrice !== null
      ? stackRow("电价", `${fmtPrice(effPrice)}（本月没有充电，沿用上次充电价估算行驶电费）`)
      : null,
    ...hi,
  ].filter(Boolean);

  const elements = [
    metricRow([
      metricBlock("里程", fmtKmTrip(summary.travel_km), ic("gauge_blue")),
      metricBlock("耗电", fmtKwh(elecKwh), ic("bolt_green")),
      metricBlock("合计费用", fmtMoney(total), ic("coin")),
    ]),
    chart({ title: "每周里程 (km)", data: chartData, xField: "name", yField: "value" }),
    collapsiblePanel(`更多数据 · ${detail.length} 项`, detail, { iconKey: ic("chevron") }),
  ];
  if (fuel && fuel.times > 0) {
    elements.splice(2, 0, note(
      `<font color='grey'>加油 ${fmtNum(fuel.times, "", 0)} 次 · ${fmtNum(fuel.liters || 0, "L", 1)} · ${fmtMoney(fuel.cost || 0)}</font>`,
    ));
  }
  return cardShell(title, `${carName(vehicle)} · ${monthLabel}`, "月度用车汇总", elements, { template: "indigo", tags });
}

/**
 * 充电小票（D-064：开始 / 结束拆成两张卡）
 *
 * - `phase: "start"` → 「开始充电」卡片：此时理想侧还没电量数据，
 *   电量/时长/电费显示 "--" 是正常的，重点是告诉用户「充电已开始」。
 * - `phase: "end"`   → 「充电完成小票」：带真实电量、时长、平均功率、电费。
 *
 * 旧版两种情况都用「充电完成小票」，导致用户收到的「开始」卡片
 * 标题是「充电完成小票」，语义完全错位（2026-11-02 用户反馈）。
 */
export function buildChargeCard({ session, priceCny, phase = "end", noData = false, vehicle, battery, range, addedKm, icons }) {
  const isStart = phase === "start";
  const typeText = { 1: "DC 直流快充", 2: "AC 交流慢充", 3: "SC 5C 超充", 4: "理想超充" }[session.charging_type] || DASH;
  const icon = (k) => (icons && icons[k]) || null;
  const clock = (ts) => String(ts || "").slice(11, 16);

  if (isStart) {
    // D-135：开始卡只回答「现在在充、充到哪、电价多少」，细节折叠
    const tags = [textTag("充电中", "green")];
    const elements = [
      metricRow([
        metricBlock("当前电量", fmtPct(battery), icon("battery")),
        metricBlock("纯电续航", fmtNum(range, "km", 0), icon("bolt")),
        metricBlock("电价", fmtPrice(priceCny), icon("coin")),
      ]),
      // 开始时间已在副标题，不重复（D-136）
      collapsiblePanel("更多 · 2 项", [
        kvRow("充电类型", typeText),
        kvRow("提示", "结束后推小票"),
      ], { iconKey: icon("chevron") }),
    ];
    return cardShell("开始充电", `${carName(vehicle)} · ${clock(session.started_at) || DASH} 开始`, "充电开始", elements, {
      template: "green", tags,
    });
  }

  // D-136：时长提到标签（一眼看到充了多久）；三块＝结束时电量（可判断有没有充满）/充入电量/电费
  const tags = [textTag(`用时 ${fmtDuration(session.duration_min)}`, "wathet")];
  const rows = [
    // D-137：续航增加（真实 Δ% × 当前每 1% 续航），放折叠第一行——一行只放 3 块指标，4 块在手机上会挤
    addedKm != null ? kvRow("续航增加", `+${fmtNum(addedKm, "km", 0)}`) : null,
    kvRow("开始时间", clock(session.started_at) || DASH),
    kvRow("充电类型", typeText),
    // 只保留「本次单价」（这次充电真正的分时加权价）；默认电价是上次充电价，容易混淆，已删
    kvRow("本次单价", session.price_per_kwh ? fmtPrice(session.price_per_kwh) : DASH),
  ];
  const rows2 = rows.filter(Boolean);
  const elements = [
    metricRow([
      metricBlock("当前电量", fmtPct(battery), icon("battery")),
      metricBlock("充入电量", fmtKwh(session.capacity_kwh), icon("bolt")),
      metricBlock("电费", fmtMoney(session.cost_cny), icon("coin")),
    ]),
    collapsiblePanel(`更多 · ${rows2.length} 项`, rows2, { iconKey: icon("chevron") }),
  ];
  if (noData) {
    elements.push(note("<font color='grey'>车机没有上报本次充入电量，只能记录起止时间与时长</font>"));
  }
  //  D-089：结束卡副标题必须是【完成时间】
  return cardShell("充电完成", `${carName(vehicle)} · ${clock(session.ended_at) || DASH} 完成`, "充电小票", elements, {
    template: "green", tags,
  });
}

/**
 *  D-069：地理围栏事件卡（到家 / 离家）。
 *   不显示精确坐标（隐私），只显示围栏名 + 距离；到家用绿色，离家用灰色。
 */
function photoGrid(images = []) {
  const usable = images.filter((i) => i.imgKey);
  const out = [];
  for (let i = 0; i < usable.length; i += 2) {
    const pair = usable.slice(i, i + 2);
    out.push({
      tag: "column_set",
      flex_mode: "bisect",
      horizontal_spacing: "8px",
      columns: pair.map((it) => ({
        tag: "column",
        width: "weighted",
        weight: 1,
        elements: [
          note(`<font color='grey'>${it.label}</font>`),
          {
            tag: "img",
            img_key: it.imgKey,
            alt: { tag: "plain_text", content: `${it.label}照片` },
            mode: "fit_horizontal",
            preview: true,
          },
        ],
      })),
    });
  }
  return out;
}

// D-141：到家 / 车辆已停好共用一张卡（同一维度，停在家就叫「到家了」）。
// 照片直接进正文，不折叠——用户明确要求不要点开才看得到。
export function buildStopCard({ kind = "home", at, battery, range, sentinelText = null, locked = null, place = null, distanceM = null, images = [], label = "家", vehicle, icons }) {
  const isHome = kind === "home";
  const clock = String(at || "").slice(11, 16) || DASH;
  const icon = (k) => (icons && icons[k]) || null;
  const tags = [];
  if (locked === true) tags.push(textTag("已锁车", "green"));
  else if (locked === false) tags.push(textTag("未锁车", "red"));

  const rows = [];
  if (!isHome && place) rows.push(kvRow("停车地点", place));
  rows.push(kvRow(isHome ? "距车位中心" : "距家的距离", fmtNum(distanceM, "m", 0)));
  rows.push(kvRow("完整时间", at || DASH));

  const elements = [
    metricRow([
      metricBlock("剩余电量", fmtPct(battery), icon("battery")),
      metricBlock("可行驶", fmtNum(range, "km", 0), icon("bolt")),
      //  哨兵是「正在录制」的状态：开启=红色同心圆，关闭=灰色同心圆（D-175）
      metricBlock("哨兵", sentinelText || DASH, /开启/.test(String(sentinelText || "")) ? icon("record_red") : icon("record_grey")),
    ]),
  ];
  if (battery !== null && battery !== undefined && Number(battery) <= 20) {
    elements.push(note("<font color='orange'>剩余电量偏低，建议充电</font>", "notation"));
  }
  elements.push(collapsiblePanel(`更多 · ${rows.length} 项`, rows, { iconKey: icon("chevron") }));
  elements.push(...photoGrid(images));

  const homeTitle = !label || label === "家" ? "到家了" : `到${label}了`;
  return cardShell(
    isHome ? homeTitle : "车辆已停好",
    `${carName(vehicle)} · ${clock}`,
    isHome ? "到家 · 停车状态" : "停车 · 车辆状态",
    elements,
    { template: isHome ? "green" : "turquoise", tags },
  );
}

/**
 * 停留时长文案：`11 小时 20 分` / `45 分钟` / `2 天 3 小时`。
 *
 * 为什么要单独写：停留可能是几分钟（出门取快递）也可能是几天（出差），
 * 固定写「X 小时 Y 分」会出现「0 小时 3 分」这种读起来别扭的文案。
 * 返回 null 表示算不出来（缺少到达时间 / 时钟异常），调用方据此不显示这一行。
 */
export function dwellText(fromAt, toAt) {
  const a = fromAt ? parseShanghai(fromAt)?.getTime() : null;
  const b = toAt ? parseShanghai(toAt)?.getTime() : null;
  if (!a || !b || b <= a) return null;
  const mins = Math.round((b - a) / 60000);
  if (mins < 1) return "不到 1 分钟";
  if (mins < 60) return `${mins} 分钟`;
  const hours = Math.floor(mins / 60);
  const m = mins % 60;
  if (hours < 24) return m ? `${hours} 小时 ${m} 分` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  const hh = hours % 24;
  return hh ? `${days} 天 ${hh} 小时` : `${days} 天`;
}

// 离开卡（D-139/D-141）：行驶中哨兵无意义，第三格换成油量
export function buildDepartureCard({ at, battery, range, fuelLevel = null, label = "家", homeSince = null, vehicle, icons }) {
  const clock = String(at || "").slice(11, 16) || DASH;
  const icon = (k) => (icons && icons[k]) || null;
  //  D-198 补充：原来第一行是「完整时间 2026-11-13 08:09:00」，标题行已经写了「08:09 出发」，
  //  同一条信息出现两次（基线 §2.2）。换成「在家停留 11 小时 20 分」——同样是这一趟的信息，但不重复。
  const dwell = dwellText(homeSince, at);
  const rows = dwell ? [kvRow("在家停留", dwell)] : [];
  // 用户：只写「离开了」不知道离开哪儿 → 带上围栏名（家 → 离开家了）
  const outTitle = !label || label === "家" ? "离开家了" : `离开${label}了`;
  return cardShell(
    outTitle,
    `${carName(vehicle)} · ${clock} 出发`,
    "出发 · 行程开始",
    [
      metricRow([
        metricBlock("电量", fmtPct(battery), icon("battery")),
        metricBlock("可行驶", fmtNum(range, "km", 0), icon("bolt")),
        metricBlock("油量", fmtPct(fuelLevel), icon("fuel_amber")),
      ]),
      ...(rows.length ? [collapsiblePanel(`更多 · ${rows.length} 项`, rows, { iconKey: icon("chevron") })] : []),
    ],
    { template: "grey" },
  );
}


// F-10 加油卡 v3（D-145）：只在「加油完成」推一张；卡内 form 输入本次油价 → 原地更新成已完成态
export function buildFuelCard({ event, priceCny = null, lastPriceCny = null, lastPriceAt = null, rangeFuel = null, done = false, vehicle, icons }) {
  const icon = (k) => (icons && icons[k]) || null;
  const liters = event?.liters;
  const clock = String(event?.ended_at || event?.started_at || "").slice(11, 16) || DASH;
  const cost = done && toNum(priceCny) !== null && toNum(liters) !== null
    ? fmtMoney(Number(liters) * Number(priceCny))
    : DASH;

  const tags = [textTag(`油量 ${fmtPct(event?.from)} → ${fmtPct(event?.to)}`, "wathet")];

  // 涨跌小标签（D-147）：比上次油价高→红色▲，低→绿色▼，持平→wathet。
  // 只在「已记录」态出现——录入前还不知道本次价格。
  const nowPrice = toNum(priceCny);
  const basePrice = toNum(lastPriceCny);
  if (done && nowPrice !== null && basePrice !== null) {
    const diff = nowPrice - basePrice;
    if (Math.abs(diff) < 0.005) tags.push(textTag("油价 持平", "wathet"));
    else if (diff > 0) tags.push(textTag(`油价 ▲ ${diff.toFixed(2)}`, "red"));
    else tags.push(textTag(`油价 ▼ ${Math.abs(diff).toFixed(2)}`, "green"));
  }

  const rows = [
    kvRow("开始时间", event?.started_at || DASH),
    kvRow("结束时间", event?.ended_at || DASH),
    kvRow("当前油量", toNum(event?.to) === null
      ? DASH
      : `约 ${fmtNum((Number(event.to) * 60) / 100, "L", 1)}`),
    // 上次油价拆两行：单价与「上次加油时间」各自成行，避免 `9.49 元/L（11-03 09:47）` 在窄屏折行（D-182/D-184）
    basePrice === null
      ? kvRow("上次油价", "未设置")
      : kvRow("上次油价", fmtPrice(basePrice, "元/L")),
    basePrice === null || !lastPriceAt
      ? null
      : kvRow("上次加油时间", mdhm(lastPriceAt)),
  ];

  const elements = [
    metricRow([
      metricBlock("加油量", fmtNum(liters, "L", 1), icon("fuel_amber")),
      metricBlock("本次花费", cost, icon("coin")),
      metricBlock("用油续航", fmtNum(rangeFuel, "km", 0), icon("bolt")),
    ]),
  ];

  if (done) {
    const priceText = nowPrice === null ? DASH : fmtPrice(nowPrice, "元/L");
    const arrow = (nowPrice !== null && basePrice !== null && Math.abs(nowPrice - basePrice) >= 0.005)
      ? (nowPrice > basePrice
          ? ` <font color='red'>▲ ${(nowPrice - basePrice).toFixed(2)}</font>`
          : ` <font color='green'>▼ ${(basePrice - nowPrice).toFixed(2)}</font>`)
      : "";
    elements.push(note(`已记录本次油价 <font color='blue'>${priceText}</font>${arrow}`, "normal"));
  } else {
    // 卡内输入框：只有应用机器人 + card.action.trigger 回调才支持（我们都有，D-146）
    elements.push({
      tag: "form",
      name: "fuel_price_form",
      direction: "vertical",
      vertical_spacing: "8px",
      elements: [
        { tag: "markdown", content: "输入**本次** 95# 单价（元/L）", text_size: "notation" },
        {
          tag: "input",
          name: "price",
          required: true,
          width: "fill",
          max_length: 5,
          placeholder: { tag: "plain_text", content: "例如 9.49" },
        },
        {
          tag: "button",
          name: "submit_price",
          form_action_type: "submit",
          text: { tag: "plain_text", content: "记录本次油价" },
          type: "primary",
          width: "fill",
        },
      ],
    });
  }

  elements.push(collapsiblePanel(`更多 · ${rows.length} 项`, rows, { iconKey: icon("chevron") }));

  return cardShell(
    done ? "加油已完成 · 已记录" : "加油已完成",
    `${carName(vehicle)} · ${clock}`,
    "加油事件",
    elements,
    { template: "orange", tags },
  );
}

/**
 * F-11 建议及时充电（D-177 原名「充电电价」，D-198 改名）。
 *  改名的原因：它和「当前电价」查询卡都摆三个电价数字，用户看不出哪张是自动推的；
 *  标题直接写「建议及时充电」，推送的意图一眼可见。
 * 用户要求：不要「建议你等到几点去充」这种无效建议（谷时 01:00~05:00 没人会出门充），
 * 也不分谷时/非谷时两种形态——只把三个数摆出来：现在多少电、现在什么价、最低什么价；
 * 想省钱自己看「电价表」里的时段。所以正文只做算术（现在充 vs 最低价充，各花多少），不下命令。
 */
export function buildChargeAdviceCard({ battery, rangeKm, nowPrice, valleyPrice, valleyWindow: valleyWindowRaw, needKwh, saveCny, tiers, nowHHMM, vehicle, icons, at }) {
  const ic = (name) => (icons && icons[name]) || null;
  const valleyWindow = valleyWindowRaw || DASH;
  const diff = nowPrice !== null && valleyPrice !== null ? round2(Number(nowPrice) - Number(valleyPrice)) : null;
  const costNow = needKwh !== null && nowPrice !== null ? fmtMoney(needKwh * Number(nowPrice)) : null;
  const costLow = needKwh !== null && valleyPrice !== null ? fmtMoney(needKwh * Number(valleyPrice)) : null;
  const parts = [];
  if (diff !== null && diff > 0.005) parts.push(`现在 ${fmtPrice(nowPrice)}，比最低价贵 ${fmtNum(diff, "", 2)}`);
  else parts.push(`现在 ${fmtPrice(nowPrice)}`);
  if (costNow && costLow) parts.push(`充到 80% 约 ${fmtNum(needKwh, "", 1)} kWh，现在要 ${costNow}，最低价时 ${costLow}`);
  else if (needKwh === null) parts.push("电量已高于 80%，暂时不用充");
  const elements = [
    metricRow([
      metricBlock("当前电量", fmtPct(battery), ic("battery")),
      metricBlock("现在电价", fmtPrice(nowPrice), ic("plug")),
      metricBlock("最低电价", fmtPrice(valleyPrice), ic("plug")),
    ]),
    note(`${parts.join("；")}。`),
  ];
  //  电价表：整张表放进折叠（用户要求折叠名叫「电价表」，且不要再放后台规则说明）
  const list = Array.isArray(tiers) ? tiers.filter((t) => t && t.from && t.to) : [];
  if (list.length) {
    const rows = list.map((t) => {
      const isNow = nowHHMM && nowHHMM >= t.from && nowHHMM < t.to;
      const price = fmtPrice(t.price);
      const label = t.label ? ` · ${t.label}` : "";
      const val = isNow ? `${price}${label} · 现在` : `${price}${label}`;
      return kvRow(`${t.from}~${t.to}`, val, [4, 4], isNow ? { color: "green" } : {});
    });
    elements.push(collapsiblePanel(`电价表 · ${list.length} 项`, rows));
  }
  return cardShell("建议及时充电", `${carName(vehicle)}${at ? ` · ${hhmm(at)} 更新` : ""}`, "现在电价与最低电价", elements, {
    template: "blue",
  });
}

/**
 * 「充电情况」一张卡顶两用（D-161）：把「充电」和「充电建议」合并。
 *  - 正在充电 → 报当前电量/续航/充电功率 + 充电中标签；
 *  - 没在充电 → 报当前电量/续航 + 直接给结论（电量充足不用充 / 现在充 / 等谷时能省多少）。
 * 结论写在第三块指标里，一眼能看到，不用再翻折叠。
 */
export function buildChargeStatusCard({ charging, battery, rangeKm, power, chargeStatusText, advice, vehicle, icons, at }) {
  const ic = (name) => (icons && icons[name]) || null;
  const adv = advice || null;
  let hint = DASH, hintColor = "grey";
  if (charging) { hint = "充电中"; hintColor = "green"; }
  else if (adv && adv.inValley) { hint = "现在是谷时"; hintColor = "green"; }
  else if (adv && adv.saveCny) { hint = `建议等谷时，省 ¥${Number(adv.saveCny).toFixed(2)}`; hintColor = "orange"; }
  else if (adv && adv.plenty) { hint = "电量充足"; hintColor = "grey"; }
  else if (adv && adv.needKwh) { hint = "建议充电"; hintColor = "orange"; }

  const third = charging
    ? metricBlock("充电功率", power != null ? fmtNum(power, "kW", 1) : DASH, ic("bolt_green"))
    : metricBlock("充电建议", hint, ic("plug"));

  const rows = [];
  rows.push(kvRow("充电状态", chargeStatusText || (charging ? "充电中" : "未充电")));
  if (adv && adv.nowPrice != null) rows.push(kvRow("现在电价", fmtPrice(adv.nowPrice)));
  if (adv && adv.valleyPrice != null) rows.push(kvRow("谷时电价", fmtPrice(adv.valleyPrice)));
  if (adv && adv.valleyWindow) rows.push(kvRow("谷时时段", adv.valleyWindow));
  if (adv && adv.needKwh != null) rows.push(kvRow("充到 80% 约需", fmtNum(adv.needKwh, "kWh", 1)));
  if (adv && adv.saveCny != null) rows.push(kvRow("谷时能省", approx(fmtMoney(adv.saveCny))));
  rows.push(kvRow("更新时间", hhmm(at)));

  const conclusion = charging
    ? "正在充电，充满或拔枪后会推一张充电小票，不用等在这里。"
    : adv && adv.inValley
      ? `现在是谷时（${adv.valleyWindow}），电价 ${fmtPrice(adv.valleyPrice)}，可以插枪。`
      : adv && adv.saveCny
        ? `建议等到谷时 **${adv.valleyWindow}**（${fmtPrice(adv.valleyPrice)}）再充，这箱电能省${approx(fmtMoney(adv.saveCny))}。`
        : adv && adv.plenty
          ? "电量还够用，暂时不用充；要出远门再充也来得及。"
          : "暂时没有可给的充电建议（不在家或缺少电价配置）。";

  return cardShell(
    "充电情况",
    `${carName(vehicle)} · ${hhmm(at)} 更新`,
    charging ? "正在充电" : "电量与充电建议",
    [
      metricRow([
        metricBlock("当前电量", fmtPct(battery), ic("battery")),
        metricBlock("纯电续航", fmtNum(rangeKm, "km", 0), ic("bolt_blue")),
        third,
      ]),
      collapsiblePanel(`更多信息 · ${rows.length} 项`, rows),
      note(conclusion),
    ],
    { template: charging ? "green" : "blue" },
  );
}

/**
 * 保养提醒（推送用，D-165）：原来是通用 notice 卡（标题 + 若干行文字），
 * 现在统一成「标题标签 + 三块指标 + 折叠全部六项」的四段式，和其余卡一致。
 * 数据来自 reminders.checkMaintenance() 的 items（全部六项）+ hits（触发的项）。
 */
/**
 * 能量提醒（D-173，从「车辆异常」里拆出来的低电量/低油量）
 *   标题按内容：`电量偏低` / `油量偏低` / `电量与油量偏低`
 *   标签：`N 项`(orange)
 *   正文：每项 stackRow(名称, 短值)，左对齐不折行
 *   折叠：完整说明（同样 stackRow + 检测时间）
 *   为什么不叫「车辆异常」：低电/低油是能量状态，不是故障（用户 2026-11-19）
 */
/**
 * 「N 天前」——只用于给用户一个时间参考，不做精确时长。
 * 用上海时区的日期串做减法，避免 UTC 跨日（D-089 的口径教训）。
 */
const mdhm = (ts) => {
  const m = String(ts || "").match(/^\d{4}-(\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : String(ts || DASH);
};

function agoText(ts, now) {
  if (!ts) return null;
  const a = String(ts).slice(0, 10);
  const b = String(now || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b)) return null;
  const days = Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
  if (!Number.isFinite(days) || days < 0) return null;
  return days === 0 ? "今天" : days === 1 ? "昨天" : `${days} 天前`;
}

export function buildEnergyCard({ items = [], at, vehicle, icons, lastChargeAt = null, lastFuelAt = null }) {
  const ic = (name) => (icons && icons[name]) || null;
  const list = items.filter(Boolean);
  const low = list.map((it) => String(it.label || ""));
  const batt = list.find((it) => /电量/.test(it.label)) || null;
  const fuel = list.find((it) => /油量/.test(it.label)) || null;
  //  正文一句话说明「哪一项低、低到多少」，数值本身放在上面的三块里，不再重复一遍（D-173）
  const lines = [];
  if (batt) lines.push(`电量 ${batt.short || batt.value}，建议尽快补电。`);
  if (fuel) lines.push(`油量 ${fuel.short || fuel.value}，建议就近加油。`);
  const elements = [
    metricRow([
      metricBlock("当前电量", `${fmtNum(batt && batt.pct, "%", 0)}`, ic("battery")),
      metricBlock("纯电续航", `${fmtNum(batt && batt.rangeKm, " km", 0)}`, ic("bolt")),
      metricBlock("当前油量", `${fmtNum(fuel && fuel.pct, "%", 0)}`, ic("fuel")),
    ]),
    ...lines.map((t) => note(t)),
    collapsiblePanel(`更多信息 · ${2 + (lastChargeAt ? 1 : 0) + (lastFuelAt ? 1 : 0)} 项`, [
      //  「上次充电/上次加油」是这一层独有的参考信息（正文与三块都没有），不违反 D-173 的不重复规则
      lastChargeAt ? stackRow("上次充电", `${mdhm(lastChargeAt)} · ${agoText(lastChargeAt, at) || DASH}`) : null,
      lastFuelAt ? stackRow("上次加油", `${mdhm(lastFuelAt)} · ${agoText(lastFuelAt, at) || DASH}`) : null,
      stackRow("检测时间", String(at || DASH)),
    ].filter(Boolean)),
  ];
  return cardShell("能量不足提醒", `${carName(vehicle)}${at ? ` · ${hhmm(at)}` : ""}`, "能量不足提醒", elements, {
    template: "orange",
  });
}

/**
 * 车辆异常（F-17，v2）
 *   标题「车辆异常」+ 标签 `N 项`(red)
 *   正文：每项一行 `stackRow(名称, 短值)`——左对齐，短值保证不折行
 *   折叠：完整时间 + 每项完整说明（含标准值/压差/处置建议，对售后时用）
 *   为什么不再用通用 alert：通用卡把长说明直接摆正文，手机上一项就折 3 行（D-173）
 */
/**
 * F-18 凭据告警（D-174）。
 * 三块只放「还剩多久、什么时候到期」，处置一句话说清；折叠放完整到期时间与影响，
 * 不再重复三块里的天数（D-173 的信息不重复规则）。
 */
export function buildCredCard({ level = "warn", daysLeft = null, expiresText = null, items = [], at = null, vehicle = null, icons }) {
  const ic = (name) => (icons && icons[name]) || null;
  const dead = level === "dead";
  const days = daysLeft != null ? `${fmtNum(daysLeft, "", 1)} 天` : DASH;
  const expire = expiresText ? String(expiresText).slice(5, 16) : DASH;
  //  没有折叠、没有标签：标题已说明状态，两块已给出天数与到期时间，其余信息对用户没有增量（D-175）
  const elements = [
    metricRow([
      metricBlock(dead ? "已失效" : "剩余可用", days, ic("clock")),
      metricBlock("到期时间", expire, ic("calendar")),
    ]),
    note(dead
      ? "授权已失效，采集中断。在项目目录运行 `app/scripts/reauthorize.sh` 重新授权即可恢复。"
      : "剩 2 天时会自动重登；若连续失败，需要在项目目录运行 `app/scripts/reauthorize.sh` 手动授权。"),
  ];
  return cardShell(dead ? "授权已失效" : "授权即将过期", `${carName(vehicle)}${at ? ` · ${hhmm(at)}` : ""}`, dead ? "授权已失效" : "授权即将过期", elements, {
    template: dead ? "red" : "orange",
  });
}

export function buildAnomalyCard({ items = [], at, vehicle, icons }) {
  const ic = (name) => (icons && icons[name]) || null;
  const list = items.filter(Boolean);
  const rows = list.map((it) => stackRow(it.label, it.short || it.value || DASH));
  //  完整说明也用 stackRow 上下两行左对齐——长说明放 kvRow 右侧必折行（D-173 用户反馈）
  const detail = list.map((it) => stackRow(it.label, String(it.value || DASH)));
  const elements = [
    ...rows,
    collapsiblePanel(`完整说明 · ${list.length + 1} 项`, [
      kvRow("检测时间", String(at || DASH), [3, 5]),
      ...detail,
    ]),
  ];
  return cardShell("车辆异常", `${carName(vehicle)}${at ? ` · ${hhmm(at)}` : ""}`, "车辆异常", elements, {
    template: "red",
    //  只有一项时不加「1 项」标签：标题已经说清楚了（D-173）
    tags: list.length > 1 ? [textTag(`${list.length} 项`, "red")] : [],
  });
}

/**
 * 充电异常（F-16，v2）
 *   三块：故障码(橙色感叹号) / 充电状态(插头) / 检测时间(时钟)
 *   标签：`已中止`(red，充电被车机中止时) + `故障码 N`(red)
 *   正文一句处置建议（这种卡是要人动手的，留一句「怎么办」最有用）
 *   折叠：完整时间 / 全部命中项（码 + 来源字段，便于对售后）
 *   口径：故障码含义以车机/售后为准，卡片不猜具体硬件（D-172）
 */
export function buildChargeFaultCard({ at, battery, vehicle, icons }) {
  const ic = (name) => (icons && icons[name]) || null;
  const pct = toNum(battery);
  //  官方没有公开故障码/中止标志的码表（2026-11-19 检索无权威来源），所以码一律不上卡；
  //  改用「结束时的电量」判断这次结束的性质（用户经验：95% 以上基本是桩/车按满电策略自动停）：
  //    ≥95% → 充电已自动完成（正常）
  //    <95%  → 充电提前结束（可能被手动终止或异常中断，值得看一眼）
  const fullish = pct !== null && pct >= 95;
  const elements = [];
  if (pct !== null) {
    elements.push(metricRow([metricBlock("结束电量", `${fmtPct(pct)}`, ic("battery"))]));
  }
  elements.push(collapsiblePanel("更多信息 · 1 项", [kvRow("完整时间", String(at || DASH), [3, 5])]));

  return cardShell(
    fullish ? "充电已自动完成" : "充电提前结束",
    `${carName(vehicle)}${at ? ` · ${hhmm(at)}` : ""}`,
    fullish ? "充电已自动完成" : "充电提前结束",
    elements,
    { template: fullish ? "green" : "red" },
  );
}

/**
 * OTA 已升级（F-14，v2）
 *   三块：升级后(闪电绿) / 升级前(仪表蓝) / 检测时间(时钟)，只显示主版本 `8.7.0`
 *   标签：`已升级`(green)
 *   折叠：完整版本号两行（`8.6.0-1.55.253` 这种 14 位放三块里必折行，所以三块只放主版本）
 *   正文不写「版本号变化代表已完成升级」这类解释——标题已说明（D-171）
 */
const shortVer = (v) => {
  const s = String(v || "").trim();
  if (!s) return DASH;
  const m = s.match(/^v?\d+(\.\d+){0,2}/);
  return m ? m[0] : s.slice(0, 8);
};

export function buildOtaCard({ before, after, at, vehicle, icons }) {
  const ic = (name) => (icons && icons[name]) || null;
  const elements = [
    metricRow([
      metricBlock("升级后", shortVer(after), ic("bolt_green")),
      metricBlock("升级前", shortVer(before), ic("gauge_blue")),
      metricBlock("检测时间", at ? hhmm(at) : DASH, ic("clock")),
    ]),
    //  只有一行数据：用 stackRow 上下两行左对齐，长版本号才不折行（D-171）
    collapsiblePanel("更多信息 · 1 项", [
      stackRow("完整版本", `${String(before || DASH)} → ${String(after || DASH)}`),
    ]),
  ];
  return cardShell("车辆已升级", `${carName(vehicle)}${at ? ` · ${hhmm(at)}` : ""}`, "车辆已升级", elements, {
    template: "green",
  });
}

/**
 * 停车掉电（F-15，v2 与新视觉语言对齐）
 *   三块：电量变化(电池·橙) / 停车时长(时钟) / 折合每小时(仪表)
 *   标签：`−N%`（orange；≥1 %/小时给 red），哨兵开启再补一枚 red 标签
 *   折叠：停车时段 / 开始电量 / 结束电量 / 采样口径
 *   为什么不把「可能原因」逐条摆正文：一句建议就够，逐条会把卡撑长（D-170）
 */
export function buildDrainCard({ from, to, hours, perHour, since, at, sentinelText, vehicle, icons }) {
  const ic = (name) => (icons && icons[name]) || null;
  const drop = Math.max(0, Math.round((toNum(from) ?? 0) - (toNum(to) ?? 0)));
  const fast = perHour != null && perHour >= 1;
  //  时长用 ASCII 缩写：中文「4 小时 12 分」在窄屏会折行（用户 2026-11-19 要求）
  const span = (() => {
    if (hours == null) return DASH;
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    if (h > 0) return `${h}h${m ? `${String(m).padStart(2, "0")}m` : ""}`;
    return `${m}m`;
  })();
  //  标签放「92% → 90%」：这是最长的字段，放三块里必折行；三块只放短数值
  const tags = [textTag(`${fmtNum(from, "", 0)}% → ${fmtNum(to, "", 0)}%`, fast ? "red" : "orange")];
  if (sentinelText === "开启") tags.push(textTag("哨兵开启", "red"));

  const timeRow = since || at
    ? [stackRow("停车时段", `${(since || DASH).slice(5, 16)} → ${(at || DASH).slice(5, 16)}`)]
    : [];

  const elements = [
    metricRow([
      metricBlock("掉电", `−${fmtNum(drop, "", 0)}%`, ic("battery")),
      metricBlock("停车时长", span, ic("clock")),
      metricBlock("折合", perHour == null ? DASH : `${fmtNum(perHour, "", 1)}%/h`, ic("gauge_blue")),
    ]),
    //  标题「停车掉电」已说明背景，正文不再放解释句；只有一行数据就不折了，直接摆出来（用户 2026-11-19）
    ...timeRow,
  ].filter(Boolean);
  return cardShell("停车掉电", `${carName(vehicle)}${at ? ` · ${hhmm(at)}` : ""}`, "停车掉电", elements, { template: "orange", tags });
}

/** 到期日 "20261129" → 距今天数（按上海时区算，不碰 new Date("YYYY-MM-DD")，D-169） */
function daysUntilDue(due) {
  if (!/^\d{8}$/.test(String(due || ""))) return null;
  const y = Number(due.slice(0, 4)), m = Number(due.slice(4, 6)), d = Number(due.slice(6, 8));
  const dueUtc = Date.UTC(y, m - 1, d);
  const nowSh = new Date(Date.now() + 8 * 3600 * 1000);
  const todayUtc = Date.UTC(nowSh.getUTCFullYear(), nowSh.getUTCMonth(), nowSh.getUTCDate());
  return Math.round((dueUtc - todayUtc) / 86400000);
}

const mmdd = (due) => (due && /^\d{8}$/.test(String(due)) ? `${due.slice(4, 6)}-${due.slice(6, 8)}` : "--");

/**
 * 保养提醒（F-13，v2 按用户 2026-11-19 决定：方案 A + 标签「N 天后到期」）
 *   三块：下次保养(橙色感叹号) / 剩余里程(仪表) / 到期日期(日历)
 *   标签：`N 天后到期`（橙，crit 红）；没有到期日才退回「剩 X km」
 *   折叠：每项一行 `剩 / 周期 km · 到期日`，左标签 + 右值对齐，避免手机折行
 *   尾注一句：上次保养时间/里程 + 口径（增程器类按增程器里程计）
 */
export function buildMaintReminderCard({ items = [], hits = [], at = null, vehicle = null, icons = null }) {
  const ic = (name) => (icons && icons[name]) || null;
  const list = items.slice().sort((a, b) => a.left - b.left);
  const top = list[0] || null;
  const hit = hits.slice().sort((a, b) => a.left - b.left)[0] || top;
  const crit = hits.some((h) => h.level === "crit") || (top && top.left <= 500);
  const leftKm = top ? top.left : null;
  const days = top && top.due ? daysUntilDue(top.due) : null;

  const tags = [];
  if (days !== null) tags.push(textTag(`${days} 天后到期`, crit || days <= 7 ? "red" : "orange"));
  else if (leftKm !== null) tags.push(textTag(`剩 ${fmtNum(leftKm, "", 0)} km`, crit ? "red" : "orange"));

  //  只放「剩余 / 周期 km」——到期日期在上面的三块里已经有了，逐行再列一遍既重复又容易折行（D-169 用户要求）
  const rows = list.map((it) => {
    const km = it.period ? `${fmtNum(it.left, "", 0)} / ${fmtNum(it.period, "", 0)} km` : `${fmtNum(it.left, "", 0)} km`;
    return kvRow(it.label, km, [4, 4]);
  });

  //  折叠面板尾部两行「数据条」（用户要求：不要提示说明的样式，要同样式的数据行）
  const tailRows = [];
  if (top && top.lastAt) {
    const km = top.lastKm != null ? ` · ${top.byEngine ? "增程器" : "总"} ${fmtNum(top.lastKm, "", 0)} km` : "";
    tailRows.push(kvRow("上次保养", `${top.lastAt}${km}`, [4, 4]));
  }
  tailRows.push(kvRow("计程口径", "增程器类按增程器计，其余按总里程", [4, 4]));

  const elements = [
    metricRow([
      metricBlock("下次保养", hit ? (hit.name || hit.label) : "--", ic("alert")),
      metricBlock("剩余里程", leftKm === null ? DASH : `${fmtNum(leftKm, "", 0)} km`, ic("gauge_blue")),
      metricBlock("到期日期", top ? mmdd(top.due) : DASH, ic("calendar")),
    ]),
    note(crit
      ? "剩余里程已接近用尽，建议尽快安排进店保养。"
      : `建议在剩余 ${fmtNum(1000, "", 0)} km 或到期前 1 个月内预约进店，可提前约。`),
    //  上次保养与计程口径作为同样式的两行数据放在面板末尾（D-169）
    collapsiblePanel(`全部保养项 · ${list.length} 项`, [...rows, ...tailRows]),
  ];
  return cardShell(
    crit ? "保养里程即将用尽" : "保养提醒",
    `${carName(vehicle)}${at ? ` · ${hhmm(at)}` : ""}`,
    crit ? "保养里程即将用尽" : "保养提醒",
    elements,
    { template: crit ? "red" : "orange", tags },
  );
}

export function buildNoticeCard({ title, subtitle = null, rows = [], template = "blue", footNote = null }) {
  const elements = rows.map((r) => note(`**${r.label}**  ${r.value}`));
  if (footNote) elements.push(note(`<font color='grey'>${footNote}</font>`));
  return cardShell(title, subtitle || "理想助手", title, elements, { template });
}

export function buildAlertCard({ title, items }) {
  const elements = items.map((it) => note(`**${it.label}**  ${it.value}`));
  return cardShell(title, "车辆异常提醒", title, elements, { template: "red" });
}

/** 行程小结（路线乙：总里程增量重建） */
/** 地址瘦身：去掉省市前缀，让卡片里一屏能看清（分享页仍显示完整地址） */
export function shortPlace(addr) {
  if (!addr || addr === "--") return "--";
  return String(addr)
    .replace(/^.{2,6}省(?=.{2,})/, "")
    .replace(/^.{2,6}市(?=.{2,})/, "")
    // 县名后补一个空格：中文长串在卡片里不好断行（原来是给某一段固定县名准备的）
    .replace(/^(.{2,4}县)(?! )/, "$1 ")
    .trim() || "--";
}

export function buildTripCard({ trip, imageKey = null, vehicle = null, icons = null }) {
  const ic = (k) => (icons && icons[k]) || null;
  const elecKwh = toNum(trip.elec_kwh);
  const fuelLiters = toNum(trip.fuel_liters);
  const elecCost = toNum(trip.cost_cny);
  const fuelCost = toNum(trip.fuel_cost_cny);
  const totalCost = (elecCost || fuelCost) !== null
    ? round2((elecCost || 0) + (fuelCost || 0)) : null;
  const distance = toNum(trip.distance_km);
  const duration = toNum(trip.duration_min);
  const avgSpeed = distance !== null && duration !== null && duration > 0
    ? round1((distance / duration) * 60) : null;
  const endAt = String(trip.ended_at || trip.started_at || "");
  const timeLabel = endAt ? String(endAt).slice(11, 16) : "";
  const adKm = toNum(trip.ad_km) || 0;

  //  D-151：用户要求「时长」只做标签（放进数据块会跨行、观感差）；其余信息进数据块/折叠
  //  D-153：用户要求标签写成「用时：…」；三块第二块改为「电量变化」结果（如 -16%），
  //   折叠里保留「电量 82% → 66%」的起止值（不重复结果）。
  const tags = [textTag(`用时：${fmtDuration(trip.duration_min)}`, "wathet")];
  const bf = toNum(trip.battery_from);
  const bt = toNum(trip.battery_to);
  const battDelta = bf !== null && bt !== null ? Math.round(bt - bf) : null;

  //  D-151：三块＝里程 / 耗电 / 本程花费（用户指定顺序；时长移到标签）
  const blocks = [
    metricBlock("里程", fmtKmTrip(trip.distance_km), ic("gauge_blue")),
    metricBlock("电量变化", battDelta !== null ? `${battDelta > 0 ? "+" : ""}${battDelta}%` : DASH, ic("battery")),
    metricBlock("本程花费", totalCost !== null && totalCost > 0 ? fmtMoney(totalCost) : DASH, ic("coin")),
  ];

  // 折叠明细：先短后长（长文本殿后，D-133 原则）
  const rows = [
    kvRow("开始时间", String(trip.started_at || DASH).slice(11, 16) || DASH),
    kvRow("结束时间", timeLabel || DASH),
    //  D-155：电量变化 → 电量消耗 → 本程电耗 → 每公里成本（用户指定相邻顺序）
    //  D-166：三块里已经有「电量变化 -10%」，折叠这行改叫「电量」只放起止值，避免同名重复
    bf !== null && bt !== null ? kvRow("电量", `${Math.round(bf)}% → ${Math.round(bt)}%`) : null,
    elecKwh !== null && elecKwh > 0.01 ? kvRow("电量消耗", fmtKwh(elecKwh)) : null,
    elecKwh !== null && distance !== null && distance > 0.1
      ? kvRow("本程电耗", `${fmtNum((elecKwh / distance) * 100, "kWh/100km", 1)}`) : null,
    totalCost !== null && totalCost > 0 && distance !== null && distance > 0.1
      ? kvRow("每公里成本", fmtNum(totalCost / distance, "元/km", 2)) : null,
    kvRow("纯电里程", fmtKmTrip(trip.elec_km)),
    kvRow("发动机里程", fmtKmTrip(trip.engine_km)),
    adKm >= 0.5 ? kvRow("智驾里程", fmtNum(adKm, "km", adKm >= 100 ? 0 : 1)) : null,
    adKm >= 0.5 && distance !== null && distance > 0.1
      ? kvRow("智驾占比", `${Math.round((adKm / distance) * 100)}%`) : null,
    toNum(trip.max_speed_kmh) !== null ? kvRow("最高车速", `${fmtNum(trip.max_speed_kmh, "km/h", 0)}（采样峰值）`) : null,
    avgSpeed !== null ? kvRow("平均车速", fmtNum(avgSpeed, "km/h", 0)) : null,
    // 直线距离（great-circle），不是道路里程
    toNum(trip.max_dist_km) !== null ? kvRow("离家最远（直线）", fmtNum(trip.max_dist_km, "km", 1)) : null,
    fuelLiters !== null && fuelLiters > 0.05 ? kvRow("本程耗油", approx(fmtNum(fuelLiters, "L", 2))) : null,
    fuelCost !== null && fuelCost > 0 ? kvRow("本程油费", approx(fmtMoney(fuelCost))) : null,
  ].filter(Boolean);

  // 起终点：各占一行（长地址不再挤在同一行）
  // 地址一行放不下就截断（手机端 ~20 个中文字符；20 字与今日小结一致）
  const cutPlace = (addr, max = 24) => {
    const t = shortPlace(addr);
    return t.length > max ? `${t.slice(0, max)}…` : t;
  };
  const locs = [
    trip.start_loc ? locRow(ic("start"), `起 · ${cutPlace(trip.start_loc)}`) : null,
    trip.end_loc ? locRow(ic("end"), `终 · ${cutPlace(trip.end_loc)}`) : null,
  ].filter(Boolean);

  const elements = [
    //  D-151：线路图放最前面（用户要求：先看图，再看数据）
    ...(imageKey ? [{ tag: "img", img_key: imageKey, alt: { tag: "plain_text", content: "行程线路图" }, mode: "fit_horizontal", preview: true }] : []),
    metricRow(blocks, "none"),
    ...locs,
    rows.length ? collapsiblePanel(`更多行程数据 · ${rows.length} 项`, rows, { expanded: false, bordered: true }) : null,
    //  D-155：蓝字链接改成按钮（open_url），点击面积更大、视觉更明确
    //  D-156：按钮前缀图标改成自绘 map.png（用户要求卡片内不出现 emoji）
    trip.route_url
      ? actionRow([{ text: "查看本次线路图", url: trip.route_url, type: "default", iconKey: ic("map") }], "none")
      : null,
  ].filter(Boolean);

  return cardShell("行程小结", [carName(vehicle), timeLabel ? `${timeLabel} 结束` : ""].filter(Boolean).join(" · "), "行程小结", elements, { template: "orange", tags });
}

/** 日期字符串 → 周几（周报柱图与高亮行用；异常返回空串） */
function weekdayCn(dateStr) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  return "周" + "日一二三四五六"[d.getUTCDay()];
}

/**
 * 周报（F-03，2026-11-13 改版；D-121 首版 → D-122 用户逐条反馈）
 * 四段式：三块主指标（里程/耗电/合计费用）→ 每日里程柱图 → 折叠明细 → 无尾注。
 *  合计费用 = 行驶电费 + 行驶油费，**不含充电花费**：充电是"买电"，行驶电费是"用电"，
 *   两者相加等于把同一度电算两次（用户明确要求，D-122）。充电花费只在折叠里展示。
 *  电价口径：优先用「本周充电实付 ÷ 本周充入电量」当行驶电费单价——这样"电价"这一行
 *   和"行驶电费"能自洽；本周没充电才退回 usagePrice。
 */
export function buildWeeklyCard({
  summary, days, weekLabel, highlights = null, energy = null, prev = null,
  vehicle = null, priceCny = null, icons = null, title = "上周用车小结",
}) {
  const ic = (k) => (icons && icons[k]) || null;
  const elecKwh = Number(summary.elec_kwh) || 0;
  const fuelCost = Number(summary.fuel_cost_cny) || 0;
  const chargeKwh = Number(summary.charge_kwh) || 0;
  const chargeTimes = Number(summary.charge_times) || 0;
  const chargeDays = (days || []).filter((d) => (Number(d.charge_kwh) || 0) > 0.05);
  const chargeCost = chargeDays.length
    ? round2(chargeDays.reduce((a, d) => a + (Number(d.cost_cny) || 0), 0))
    : null;
  // 本周充电均价（元/度）；没有充电时退回上一次充电电价
  const weekPrice = chargeCost !== null && chargeKwh > 0.05 ? chargeCost / chargeKwh : null;
  const effPrice = weekPrice !== null ? weekPrice : (priceCny !== null && priceCny !== undefined && priceCny !== "" ? Number(priceCny) : null);
  const drivingCost = effPrice !== null ? round2(elecKwh * effPrice) : round2(Number(summary.cost_cny) || 0);
  const total = round2(drivingCost + fuelCost);
  const adKm = Number(summary.ad_km) || 0;

  // D-115：标签最多 2 个，优先级 智驾(蓝) > 充电(绿) > 用油(橙)
  // D-125：周报标签顺序＝充电 > 用油 > 智驾，最多 2 个（三样都有时丢智驾，绝不出现 3 个）——
  //   与日报同规：手机一行放不下 3 个标签就会折行；出现什么放什么，不够就顺位补。
  const allTags = [];
  if (chargeKwh > 0.05) allTags.push(textTag(`充电 ${fmtNum(chargeTimes, "", 0)} 次 · ${fmtKwh(chargeKwh)}`, "green"));
  if (Number(summary.fuel_l) > 0.05) allTags.push(textTag(`用油 ${fmtNum(summary.fuel_l, "L", 1)}`, "orange"));
  if (adKm >= 0.5) allTags.push(textTag(`智驾 ${fmtNum(adKm, "km", adKm >= 100 ? 0 : 1)}`, "blue"));
  const tags = allTags.slice(0, 2);

  const pctCmp = (cur, base) => {
    const c = toNum(cur), b = toNum(base);
    if (c === null || b === null || b === 0) return DASH;
    const pct = ((c - b) / Math.abs(b)) * 100;
    const sign = Math.abs(pct) < 0.5 ? "持平" : `${pct > 0 ? "+" : ""}${pct.toFixed(0)}%`;
    return `${sign}（上周 ${fmtKmTrip(b)}）`;
  };

  // D-122/D-123：三条高亮——行驶距离最长/最短相邻，最费油放最后且用「发动机里程」
  const moved = (days || []).filter((d) => (Number(d.travel_km) || 0) > 0);
  const hi = [];
  if (moved.length) {
    const far = moved.slice().sort((a, b) => (Number(b.travel_km) || 0) - (Number(a.travel_km) || 0))[0];
    hi.push(kvRow("行驶距离最长的一天", `${String(far.stat_date).slice(5)} ${weekdayCn(far.stat_date)} · ${fmtKmTrip(far.travel_km)}`, [4, 4]));
    const near = moved.slice().sort((a, b) => (Number(a.travel_km) || 0) - (Number(b.travel_km) || 0))[0];
    hi.push(kvRow("行驶距离最短的一天", `${String(near.stat_date).slice(5)} ${weekdayCn(near.stat_date)} · ${fmtKmTrip(near.travel_km)}`, [4, 4]));
    //  D-123：最费油的一天必须用「发动机里程」，不能用当天总里程——
    //   否则会出现「本周发动机里程 38.8 km，但最费油的一天跑了 40.4 km」的自相矛盾（用户抓到）。
    const fuelDay = moved.slice().sort((a, b) => (Number(b.fuel_l) || 0) - (Number(a.fuel_l) || 0))[0];
    if ((Number(fuelDay.fuel_l) || 0) > 0.05) {
      // D-124：这一行三个数值 + 日期，手机并排必折三行 → 改成上下两行式
      hi.push(stackRow("最费油的一天", `${String(fuelDay.stat_date).slice(5)} ${weekdayCn(fuelDay.stat_date)} · 发动机 ${fmtKmTrip(fuelDay.hybrid_km)} · ${fmtNum(fuelDay.fuel_l, "L", 1)} · ${fmtMoney(fuelDay.fuel_cost_cny)}`));
    }
  }

  // D-125：上周对比值 —— 箭头代替中文（「70.8 → 278.5」），去掉重复单位以省宽度
  const cmpText = (() => {
    const p0 = Number(prev?.travel_km);
    const c0 = Number(energy?.travel_km);
    if (!(p0 > 0) || !(c0 >= 0)) return DASH;
    const pct = ((c0 - p0) / p0) * 100;
    return `${pct >= 0 ? "+" : "-"}${Math.abs(pct).toFixed(0)}%（${fmtNum(p0, "", 1)} km → ${fmtNum(c0, "", 1)} km）`;
  })();

  const detail = [
    kvRow("纯电里程", fmtKmTrip(summary.elec_km)),
    kvRow("发动机里程", fmtKmTrip(summary.hybrid_km)),
    kvRow("纯电占比", fmtPct(summary.pure_ratio || 0)),
    // D-123：行驶电费只放"用车消耗的电"；充电花的是买电的钱，单列一行（放在充电均价上面）
    kvRow("行驶电费", fmtMoney(drivingCost)),
    kvRow("行驶油费", fmtMoney(fuelCost)),
    adKm >= 0.5 ? kvRow("智驾里程", fmtKmTrip(summary.ad_km)) : null,
    kvRow("驾驶天数", `${fmtNum(summary.active_days, "", 0)} / 7 天`),
    kvRow("日均里程", fmtKmTrip(summary.daily_avg_km)),
    energy ? kvRow("每公里综合成本", fmtMoney(energy.cost_per_km)) : null,
    energy ? kvRow("电耗率", fmtNum(energy.elec_kwh_per_100km, "kWh/100km", 1)) : null,
    energy ? kvRow("油耗率", fmtNum(energy.fuel_l_per_100km, "L/100km", 1)) : null,
    // D-124/D-125：手机长值必折行 → 中文标签「和上周对比」，值用「+293%（70.8 → 278.5）」
    // D-125：手机上一行放不下（也确认过收窄无效）→ 用两行式，值独占整行，括号内保留 km（单看数字缺单位）
    energy ? stackRow("和上周对比", cmpText) : null,
    chargeCost !== null ? kvRow("充电花费", fmtMoney(chargeCost), [4, 4]) : null,
    effPrice !== null
      ? kvRow(weekPrice !== null ? "本周充电均价" : "电价（上次充电）", fmtPrice(effPrice), [4, 4])
      : null,
    ...hi,
  ].filter(Boolean);

  // D-122：柱图标题「每日里程」，x 轴带周几（只看日期要翻日历才知道礼拜几）
  const chartData = (days || []).map((d) => ({
    name: `${String(d.stat_date || "").slice(5)} ${weekdayCn(d.stat_date)}`,
    value: Number(d.travel_km || 0).toFixed(1),
  }));
  const elements = [
    metricRow([
      metricBlock("里程", fmtKmTrip(summary.travel_km), ic("gauge_blue")),
      metricBlock("耗电", fmtKwh(summary.elec_kwh), ic("bolt_green")),
      metricBlock("合计费用", fmtMoney(total), ic("coin")),
    ]),
  ];
  if (chartData.length) {
    elements.push(chart({
      title: "每日里程 (km)",
      data: chartData,
      xField: "day",
      yField: "km",
      color: ["#4F8CFF"],
    }));
  }
  elements.push(collapsiblePanel(`更多数据 · ${detail.length} 项`, detail, { iconKey: ic("chevron") }));
  const subtitle = `${carName(vehicle)} · ${weekLabel}`;
  return cardShell(title, subtitle, "周度用车汇总", elements, { template: "indigo", tags });
}

/**
 * 按钮排（D-150 修复）：Card 2.0 里 button 必须放进 column_set 的 column 里。
 * 按钮点击走 callback，value 里放 { cmd }，由 commands.planCardAction 分发——
 * 回调必须 3 秒内返回（D-087），所以这里只做纯展示，不碰 I/O。
 */
/**
 * 推送开关卡（D-158）：11 类推送，一行一个「名称 · 状态 · 按钮」。
 * 按钮回传 `{toggle: kind}`，服务端切换后 PATCH 原地更新这张卡（不新增消息）。
 */
export function buildSwitchCard({ switches = {}, kinds = [], labels = {}, vehicle = null } = {}) {
  const rows = kinds.map((k) => ({
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "6px",
    columns: [
      {
        tag: "column", width: "weighted", weight: 1, vertical_align: "center",
        elements: [{ tag: "markdown", content: `**${labels[k] || k}**`, text_size: "normal" }],
      },
      {
        tag: "column", width: "auto", vertical_align: "center",
        elements: [{
          tag: "markdown",
          content: switches[k] ? "<font color='green'>开启</font>" : "<font color='grey'>关闭</font>",
          text_size: "normal",
        }],
      },
      {
        tag: "column", width: "auto", vertical_align: "center",
        elements: [{
          tag: "button",
          text: { tag: "plain_text", content: switches[k] ? "关闭" : "开启" },
          type: "default",
          size: "small",
          behaviors: [{ type: "callback", value: { toggle: k } }],
        }],
      },
    ],
  }));
  return cardShell(
    "推送开关",
    `${carName(vehicle)} · 点按钮立即生效`,
    "推送开关",
    rows,
    { template: "grey" },
  );
}

export function actionRow(buttons, flexMode = "flow") {
  const cols = (buttons || []).filter(Boolean).map((b) => ({
    tag: "column",
    width: "auto",
    elements: [{
      tag: "button",
      text: { tag: "plain_text", content: String(b.text || "") },
      type: b.type || "default",
      size: b.size || "small",
      //  D-155：带 url 的按钮走「打开链接」，其余走卡片回调（D-150）
      behaviors: b.url
        ? [{ type: "open_url", default_url: String(b.url) }]
        : [{ type: "callback", value: b.value || { cmd: b.cmd || b.text } }],
      //  D-156：自绘 PNG 图标（custom_icon），官方 2.0 button 支持 icon 字段
      ...(b.iconKey ? { icon: { tag: "custom_icon", img_key: String(b.iconKey) } } : {}),
    }],
  }));
  if (!cols.length) return null;
  return { tag: "column_set", flex_mode: flexMode, horizontal_spacing: "8px", columns: cols };
}

/** 给任意卡片底部追加一排按钮（没有按钮时原样返回，避免产生空 column_set） */
export function withActions(card, buttons) {
  const row = actionRow(buttons, "flow");
  if (!row || !card || !card.body) return card;
  return { ...card, body: { ...card.body, elements: [...(card.body.elements || []), row] } };
}

/**
 * F-19 指令菜单（D-179）。按飞书常驻菜单的三分类重排：车辆状态 / 用车报告 / 更多信息。
 * 卡片本身只承担两件事：常用指令的按钮（点一下就走），以及三组指令的速查表（默认收起）。
 * 之所以做成折叠而不是平铺 19 行：它是「查表单」，用户 90% 的场景是点按钮，不该先滑一屏。
 */
export function buildMenuCard({ groups = [], buttons = [], vehicle } = {}) {
  // D-186：用户要求菜单卡不放提示语——副标题已有「只读查询」，正文只留按钮与三组速查
  const elements = [];
  if (buttons.length) elements.push(actionRow(buttons, "flow"));
  for (const g of groups) {
    const rows = (g.items || []).map(([cmd, desc]) => kvRow(cmd, desc, [4, 6]));
    if (rows.length) elements.push(collapsiblePanel(`${g.title} · ${rows.length} 条`, rows));
  }
  return cardShell("指令菜单", `${carName(vehicle)} · 只读查询`, "指令菜单", elements, { template: "blue" });
}
